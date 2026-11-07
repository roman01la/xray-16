// Standalone browser probe; no engine, game data or existing OPFS state required.
#include <emscripten/wasmfs.h>
#include <fcntl.h>
#include <unistd.h>
#include <cstdio>
#include <cerrno>
#include <sys/stat.h>
int main()
{
    const auto backend = wasmfs_create_fetch_backend("/pack", 16 * 1024 * 1024);
    wasmfs_create_directory("/stream", 0777, backend);
    mkdir("/stream/resources", 0777);
    const int file = open("/stream/resources/test.db", O_CREAT | O_RDONLY, 0444);
    struct stat info{};
    const int status = fstat(file, &info);
    char bytes[4]{};
    const auto count = pread(file, bytes, 3, 16 * 1024 * 1024 - 1);
    const bool ok = file >= 0 && status == 0 && info.st_size == 32 * 1024 * 1024 + 5 &&
        count == 3 && bytes[0] == 'A' && bytes[1] == 'B' && bytes[2] == 'B';
    printf("STREAM_PROBE %s: pread=%ld value=%s size=%lld errno=%d\n",
        ok ? "PASS" : "FAIL", long(count), bytes, (long long)info.st_size, errno);
    if (file >= 0) close(file);
    return ok ? 0 : 1;
}
