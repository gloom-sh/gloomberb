// Diagnostic only: records every first-chance exception in the process it is
// loaded into, ahead of any other handler, then lets the exception go on.
// The handler only copies into static memory (a thread out of stack can still
// run it); a logger thread writes the records, thread names and modules out.
#include <windows.h>
#include <intrin.h>
#include <psapi.h>

#define MAX_ENTRIES 256
#define STACK_WORDS 96

typedef struct {
  volatile LONG state; // 0 empty, 1 recorded, 2 written
  DWORD code, tid, words;
  ULONG64 address, rsp, stack_base, stack_limit, deallocation, info0, info1, when;
  ULONG64 stack[STACK_WORDS];
} Entry;

static Entry g_entries[MAX_ENTRIES];
static volatile LONG g_next = 0;
static HANDLE g_log = INVALID_HANDLE_VALUE;
static int g_installed = 0;

static LONG CALLBACK record_exception(PEXCEPTION_POINTERS info) {
  DWORD code = info->ExceptionRecord->ExceptionCode;
  // Thread naming and OutputDebugString.
  if (code == 0x406D1388 || code == 0x40010006 || code == 0x4001000A) return EXCEPTION_CONTINUE_SEARCH;
  LONG i = InterlockedIncrement(&g_next) - 1;
  if (i >= MAX_ENTRIES) return EXCEPTION_CONTINUE_SEARCH;
  Entry* e = &g_entries[i];
  e->code = code;
  e->tid = __readgsdword(0x48);
  e->address = (ULONG64)info->ExceptionRecord->ExceptionAddress;
  e->info0 = info->ExceptionRecord->NumberParameters > 0 ? info->ExceptionRecord->ExceptionInformation[0] : 0;
  e->info1 = info->ExceptionRecord->NumberParameters > 1 ? info->ExceptionRecord->ExceptionInformation[1] : 0;
  e->rsp = info->ContextRecord->Rsp;
  e->stack_base = __readgsqword(0x08);
  e->stack_limit = __readgsqword(0x10);
  e->deallocation = __readgsqword(0x1478);
  e->when = *(volatile ULONG64*)0x7FFE0008; // interrupt time, 100 ns
  ULONG64 sp = e->rsp;
  DWORD n = 0;
  while (n < STACK_WORDS && sp >= e->stack_limit && sp + 8 <= e->stack_base) {
    e->stack[n++] = *(ULONG64*)sp;
    sp += 8;
  }
  e->words = n;
  InterlockedExchange(&e->state, 1);
  // Give the logger a moment to write this out before the process may die.
  for (ULONG64 spin = 0; spin < 200000000ULL && e->state != 2; ++spin) YieldProcessor();
  return EXCEPTION_CONTINUE_SEARCH;
}

static char* put_hex(char* p, ULONG64 v) {
  char tmp[16];
  int n = 0;
  do { tmp[n++] = "0123456789abcdef"[v & 15]; v >>= 4; } while (v && n < 16);
  while (n) *p++ = tmp[--n];
  return p;
}

static char* put_str(char* p, const char* s) {
  while (*s) *p++ = *s++;
  return p;
}

static void write_out(const char* start, char* end) {
  DWORD written;
  WriteFile(g_log, start, (DWORD)(end - start), &written, NULL);
}

typedef HRESULT(WINAPI* GetThreadDescriptionFn)(HANDLE, PWSTR*);

static DWORD WINAPI write_records(LPVOID unused) {
  static char line[16384];
  static ULONG64 seen[1024];
  int seen_count = 0;
  LONG written = 0;
  GetThreadDescriptionFn describe = (GetThreadDescriptionFn)GetProcAddress(GetModuleHandleA("kernel32.dll"), "GetThreadDescription");
  ULONG64 last_scan = 0;
  for (;;) {
    ULONG64 now = GetTickCount64();
    if (now - last_scan > 500) {
      last_scan = now;
      HMODULE modules[1024];
      DWORD needed = 0;
      if (K32EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &needed)) {
        for (DWORD m = 0; m < needed / sizeof(HMODULE) && m < 1024; ++m) {
          ULONG64 base = (ULONG64)modules[m];
          int known = 0;
          for (int s = 0; s < seen_count; ++s) if (seen[s] == base) { known = 1; break; }
          if (known || seen_count >= 1024) continue;
          seen[seen_count++] = base;
          MODULEINFO mi;
          char name[MAX_PATH];
          if (!K32GetModuleInformation(GetCurrentProcess(), modules[m], &mi, sizeof(mi))) continue;
          DWORD len = GetModuleFileNameA(modules[m], name, MAX_PATH);
          if (len >= MAX_PATH) len = MAX_PATH - 1;
          name[len] = 0;
          char* p = put_str(line, "module ");
          p = put_hex(p, base); *p++ = ' ';
          p = put_hex(p, mi.SizeOfImage); *p++ = ' ';
          p = put_str(p, name); *p++ = '\n';
          write_out(line, p);
        }
      }
    }
    while (written < MAX_ENTRIES && g_entries[written].state == 1) {
      Entry* e = &g_entries[written];
      char* p = put_str(line, "exception ");
      p = put_hex(p, written);
      p = put_str(p, " at "); p = put_hex(p, e->when / 10000);
      p = put_str(p, "ms code "); p = put_hex(p, e->code);
      p = put_str(p, " address "); p = put_hex(p, e->address);
      p = put_str(p, " info "); p = put_hex(p, e->info0); *p++ = '/'; p = put_hex(p, e->info1);
      p = put_str(p, " thread "); p = put_hex(p, e->tid);
      if (describe) {
        HANDLE thread = OpenThread(THREAD_QUERY_LIMITED_INFORMATION, FALSE, e->tid);
        PWSTR text = NULL;
        if (thread && SUCCEEDED(describe(thread, &text)) && text) {
          char narrow[256];
          int n = WideCharToMultiByte(CP_UTF8, 0, text, -1, narrow, sizeof(narrow) - 1, NULL, NULL);
          narrow[n > 0 ? n : 0] = 0;
          p = put_str(p, " \""); p = put_str(p, narrow); *p++ = '"';
          LocalFree(text);
        }
        if (thread) CloseHandle(thread);
      }
      p = put_str(p, " rsp "); p = put_hex(p, e->rsp);
      p = put_str(p, " stack "); p = put_hex(p, e->stack_limit); *p++ = '-'; p = put_hex(p, e->stack_base);
      p = put_str(p, " reserved from "); p = put_hex(p, e->deallocation);
      p = put_str(p, "\n  words");
      for (DWORD w = 0; w < e->words; ++w) { *p++ = ' '; p = put_hex(p, e->stack[w]); }
      *p++ = '\n';
      write_out(line, p);
      InterlockedExchange(&e->state, 2);
      ++written;
    }
    Sleep(1);
  }
  return 0;
}

__declspec(dllexport) int veh_installed(void) { return g_installed; }

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  char path[MAX_PATH];
  DWORD n = GetEnvironmentVariableA("GLOOM_DIAG_VEH_LOG", path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return TRUE;
  g_log = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (g_log == INVALID_HANDLE_VALUE) return TRUE;
  char hello[64];
  char* p = put_str(hello, "installed in pid ");
  p = put_hex(p, GetCurrentProcessId()); *p++ = '\n';
  write_out(hello, p);
  if (AddVectoredExceptionHandler(1, record_exception)) g_installed = 1;
  CreateThread(NULL, 1 << 20, write_records, NULL, 0, NULL);
  return TRUE;
}
