/*
 * kldec.c - offline decryptor for kl.dat record streams
 *
 * Build: cl /O2 kldec.c /link bcrypt.lib
 *        x86_64-w64-mingw32-gcc -O2 -o kldec.exe kldec.c -lbcrypt
 * Usage: kldec kl.dat > plaintext.txt
 */

#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS

#include <windows.h>
#include <bcrypt.h>
#include <fcntl.h>
#include <io.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _MSC_VER
#pragma comment(lib, "bcrypt.lib")
#endif

/* Must match CFG_SECRET in kl.c */
static const char CFG_SECRET[] = "change-me-32+chars-random-passphrase";

static uint8_t g_key[32];

static uint32_t rd32(const uint8_t *p)
{
    return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) |
           ((uint32_t) p[3] << 24);
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

static BOOL unseal(const uint8_t *rec, DWORD cipher_len, uint8_t *plain, DWORD *plain_len)
{
    BCRYPT_ALG_HANDLE alg = NULL;
    BCRYPT_KEY_HANDLE key = NULL;
    uint8_t iv[16];
    ULONG produced = 0;
    BOOL ok = FALSE;

    memcpy(iv, rec + 12, sizeof(iv));

    if (BCryptOpenAlgorithmProvider(&alg, BCRYPT_AES_ALGORITHM, NULL, 0) != 0)
        return FALSE;
    if (BCryptSetProperty(alg, BCRYPT_CHAINING_MODE, (PUCHAR) BCRYPT_CHAIN_MODE_CBC,
                          sizeof(BCRYPT_CHAIN_MODE_CBC), 0) != 0)
        goto done;
    if (BCryptGenerateSymmetricKey(alg, &key, NULL, 0, g_key, sizeof(g_key), 0) != 0)
        goto done;

    if (BCryptDecrypt(key, (PUCHAR) (rec + 28), cipher_len, NULL, iv, sizeof(iv), plain,
                      cipher_len, &produced, BCRYPT_BLOCK_PADDING) != 0)
        goto done;

    *plain_len = produced;
    ok = TRUE;

done:
    if (key)
        BCryptDestroyKey(key);
    if (alg)
        BCryptCloseAlgorithmProvider(alg, 0);
    return ok;
}

int main(int argc, char **argv)
{
    HANDLE f;
    LARGE_INTEGER li;
    uint8_t *blob;
    DWORD got = 0, total;
    size_t off = 0;

    if (argc < 2) {
        fprintf(stderr, "usage: %s <kl.dat>\n", argv[0]);
        return 1;
    }

    derive_key();

    _setmode(_fileno(stdout), _O_BINARY);

    f = CreateFileA(argv[1], GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
                    FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "cannot open %s\n", argv[1]);
        return 1;
    }

    if (!GetFileSizeEx(f, &li) || li.QuadPart <= 0) {
        CloseHandle(f);
        return 1;
    }
    total = (DWORD) li.QuadPart;

    blob = (uint8_t *) malloc(total);
    if (!blob) {
        CloseHandle(f);
        return 1;
    }
    if (!ReadFile(f, blob, total, &got, NULL) || got != total) {
        CloseHandle(f);
        free(blob);
        return 1;
    }
    CloseHandle(f);

    while (off + 28 <= total) {
        uint32_t plain_len;
        DWORD cipher_len;
        uint8_t *plain;

        if (memcmp(blob + off, "KLOG", 4) != 0) {
            ++off;
            continue;
        }

        plain_len = rd32(blob + off + 8);
        if (plain_len == 0 || plain_len > (1u << 22)) {
            ++off;
            continue;
        }

        cipher_len = ((plain_len / 16) + 1) * 16;
        if (off + 28 + cipher_len > total)
            break;

        plain = (uint8_t *) malloc(cipher_len + 16);
        if (!plain)
            break;

        {
            DWORD out_len = 0;
            if (unseal(blob + off, cipher_len, plain, &out_len) && out_len > 0) {
                fwrite(plain, 1, out_len, stdout);
                fflush(stdout);
            }
        }

        free(plain);
        off += 28 + cipher_len;
    }

    free(blob);
    return 0;
}
