/* kl_roundtrip.c - exercises seal/flush from kl.c and matches kldec.c parsing */

#define KL_TEST_BUILD
#include "kl.c"

int main(void)
{
    InitializeCriticalSection(&g_lock);
    derive_key();

    wcscpy(g_dir, L".");
    wcscpy(g_log, L"kl_test.dat");
    DeleteFileW(g_log);

    append_raw("hello ", 6);
    afmt("world %d\r\n", 42);
    {
        const char *s = "segundo registro \xc3\xb1\r\n";
        append_raw(s, strlen(s));
    }

    EnterCriticalSection(&g_lock);
    flush_locked();
    LeaveCriticalSection(&g_lock);

    append_raw("tail", 4);
    EnterCriticalSection(&g_lock);
    flush_locked();
    LeaveCriticalSection(&g_lock);

    return 0;
}
