// Diagnostic only: records every first-chance exception in the process it is
// loaded into, ahead of any other handler, then lets the exception go on.
// It also records every change to executable memory: ntdll's protect, commit
// and free system calls are routed through it, and a call is kept when it
// makes memory executable, or touches memory that has been executable. All
// calls also go to a ring, and a watcher thread checks the pages made
// executable: when one stops being executable with no call recorded for it,
// the ring's calls since the page was last seen executable are written out.
// The handlers only copy into static memory (a thread out of stack can still
// run them); a logger thread writes the records, thread names and modules out.
#include <windows.h>
#include <intrin.h>
#include <psapi.h>
#include <string.h>

#define MAX_ENTRIES 256
#define STACK_WORDS 96
#define MAX_CALLS 32768
#define CALL_FRAMES 12
#define MAX_WATCHED 16384
#define RING 65536
#define MAX_PAGES 8192

typedef LONG NTSTATUS;
typedef NTSTATUS(NTAPI* NtProtectFn)(HANDLE, PVOID*, PSIZE_T, ULONG, PULONG);
typedef NTSTATUS(NTAPI* NtAllocFn)(HANDLE, PVOID*, ULONG_PTR, PSIZE_T, ULONG, ULONG);
typedef NTSTATUS(NTAPI* NtFreeFn)(HANDLE, PVOID*, PSIZE_T, ULONG);
typedef NTSTATUS(NTAPI* NtAllocExFn)(HANDLE, PVOID*, PSIZE_T, ULONG, ULONG, PVOID, ULONG);
typedef USHORT(NTAPI* CaptureFn)(ULONG, ULONG, PVOID*, PULONG);

typedef struct {
  volatile LONG state; // 0 empty, 1 recorded, 2 written
  DWORD code, tid, words;
  ULONG64 address, rsp, stack_base, stack_limit, deallocation, info0, info1, when;
  ULONG64 stack[STACK_WORDS];
  // VirtualQuery of the faulting data address (info1) for access violations.
  int queried;
  ULONG64 q_base, q_alloc_base, q_size;
  DWORD q_alloc_protect, q_state, q_protect, q_type;
} Entry;

typedef struct {
  volatile LONG state;
  char kind; // p protect, a alloc, x alloc ex, f free
  char other_handle;
  DWORD tid;
  NTSTATUS status;
  ULONG64 when, base, size, arg, old;
  ULONG64 frames[CALL_FRAMES];
  USHORT frame_count;
} Call;

static Entry g_entries[MAX_ENTRIES];
static volatile LONG g_next = 0;
static Call g_calls[MAX_CALLS];
static volatile LONG g_next_call = 0;
static ULONG64 g_watched_base[MAX_WATCHED], g_watched_end[MAX_WATCHED];
static volatile LONG g_watched = 0;
static HANDLE g_log = INVALID_HANDLE_VALUE;
static int g_installed = 0;
static int g_hooked = 0;
static NtProtectFn g_protect;
static NtAllocFn g_alloc;
static NtFreeFn g_free;
static NtAllocExFn g_alloc_ex;
static Call g_ring[RING];
static volatile LONG g_ring_next = 0;
// Single pages made executable by a protect call (not image or JIT pools).
static ULONG64 g_pages[MAX_PAGES];
static volatile LONG g_page_state[MAX_PAGES]; // 0 executable, 1 released by a recorded call, 2 reported
static ULONG64 g_page_seen[MAX_PAGES];
static volatile LONG g_page_count = 0;
static CaptureFn g_capture;

#define EXEC_MASK (PAGE_EXECUTE | PAGE_EXECUTE_READ | PAGE_EXECUTE_READWRITE | PAGE_EXECUTE_WRITECOPY)

static int watched(ULONG64 base, ULONG64 end) {
  LONG n = g_watched;
  if (n > MAX_WATCHED) n = MAX_WATCHED;
  for (LONG i = 0; i < n; ++i) {
    if (base < g_watched_end[i] && g_watched_base[i] < end) return 1;
  }
  return 0;
}

static void watch(ULONG64 base, ULONG64 end) {
  if (watched(base, end)) return;
  LONG i = InterlockedIncrement(&g_watched) - 1;
  if (i >= MAX_WATCHED) return;
  g_watched_base[i] = base;
  g_watched_end[i] = end;
}

static __declspec(noinline) void fill_call(Call* c, char kind, char other, NTSTATUS status, ULONG64 base, ULONG64 size, ULONG64 arg, ULONG64 old) {
  c->kind = kind;
  c->other_handle = other;
  c->tid = __readgsdword(0x48);
  c->status = status;
  c->when = *(volatile ULONG64*)0x7FFE0008;
  c->base = base;
  c->size = size;
  c->arg = arg;
  c->old = old;
  c->frame_count = g_capture ? g_capture(3, CALL_FRAMES, (PVOID*)c->frames, NULL) : 0;
}

static __declspec(noinline) void ring_call(char kind, char other, NTSTATUS status, ULONG64 base, ULONG64 size, ULONG64 arg, ULONG64 old) {
  LONG i = InterlockedIncrement(&g_ring_next) - 1;
  Call* c = &g_ring[i & (RING - 1)];
  InterlockedExchange(&c->state, 0);
  fill_call(c, kind, other, status, base, size, arg, old);
  InterlockedExchange(&c->state, 1);
}

static __declspec(noinline) void record_call(char kind, char other, NTSTATUS status, ULONG64 base, ULONG64 size, ULONG64 arg, ULONG64 old) {
  LONG i = InterlockedIncrement(&g_next_call) - 1;
  if (i >= MAX_CALLS) return;
  Call* c = &g_calls[i];
  fill_call(c, kind, other, status, base, size, arg, old);
  InterlockedExchange(&c->state, 1);
}

static void add_page(ULONG64 base, ULONG64 size) {
  if (size != 0x1000) return;
  LONG n = g_page_count;
  for (LONG i = 0; i < n && i < MAX_PAGES; ++i) {
    if (g_pages[i] == base) { g_page_seen[i] = *(volatile ULONG64*)0x7FFE0008; InterlockedExchange(&g_page_state[i], 0); return; }
  }
  LONG i = InterlockedIncrement(&g_page_count) - 1;
  if (i >= MAX_PAGES) return;
  g_page_seen[i] = *(volatile ULONG64*)0x7FFE0008;
  g_page_state[i] = 0;
  g_pages[i] = base;
}

static void release_pages(ULONG64 base, ULONG64 end) {
  LONG n = g_page_count;
  for (LONG i = 0; i < n && i < MAX_PAGES; ++i) {
    if (g_pages[i] >= base && g_pages[i] < end && g_page_state[i] == 0) InterlockedExchange(&g_page_state[i], 1);
  }
}

// 0 another process, 1 the pseudo-handle, 2 a real handle to this process.
static int own_process(HANDLE process) {
  if (process == (HANDLE)(LONG_PTR)-1) return 1;
  return GetProcessId(process) == GetCurrentProcessId() ? 2 : 0;
}

static NTSTATUS NTAPI hook_protect(HANDLE process, PVOID* base, PSIZE_T size, ULONG protect, PULONG old) {
  NTSTATUS status = g_protect(process, base, size, protect, old);
  int own = own_process(process);
  if (own && base && size) {
    ULONG64 b = (ULONG64)*base, e = b + *size;
    ULONG prior = old ? *old : 0;
    int exec = (protect & EXEC_MASK) != 0;
    ring_call('p', own == 2, status, b, e - b, protect, prior);
    if (exec || (prior & EXEC_MASK) || watched(b, e)) {
      record_call('p', own == 2, status, b, e - b, protect, prior);
      if (exec && status >= 0) { watch(b, e); add_page(b, e - b); }
      if (!exec && status >= 0) release_pages(b, e);
    }
  }
  return status;
}

static NTSTATUS NTAPI hook_alloc(HANDLE process, PVOID* base, ULONG_PTR zero_bits, PSIZE_T size, ULONG type, ULONG protect) {
  ULONG64 asked = base ? (ULONG64)*base : 0;
  NTSTATUS status = g_alloc(process, base, zero_bits, size, type, protect);
  int own = own_process(process);
  if (own && base && size) {
    ULONG64 b = status >= 0 ? (ULONG64)*base : asked, e = b + *size;
    int exec = (protect & EXEC_MASK) != 0;
    ring_call('a', own == 2, status, b, e - b, ((ULONG64)type << 32) | protect, 0);
    if ((exec && (type & MEM_COMMIT)) || (b && watched(b, e))) {
      record_call('a', own == 2, status, b, e - b, ((ULONG64)type << 32) | protect, 0);
      if (exec && (type & MEM_COMMIT) && status >= 0) watch(b, e);
    }
  }
  return status;
}

static NTSTATUS NTAPI hook_alloc_ex(HANDLE process, PVOID* base, PSIZE_T size, ULONG type, ULONG protect, PVOID params, ULONG count) {
  ULONG64 asked = base ? (ULONG64)*base : 0;
  NTSTATUS status = g_alloc_ex(process, base, size, type, protect, params, count);
  int own = own_process(process);
  if (own && base && size) {
    ULONG64 b = status >= 0 ? (ULONG64)*base : asked, e = b + *size;
    int exec = (protect & EXEC_MASK) != 0;
    ring_call('x', own == 2, status, b, e - b, ((ULONG64)type << 32) | protect, 0);
    if ((exec && (type & MEM_COMMIT)) || (b && watched(b, e))) {
      record_call('x', own == 2, status, b, e - b, ((ULONG64)type << 32) | protect, 0);
      if (exec && (type & MEM_COMMIT) && status >= 0) watch(b, e);
    }
  }
  return status;
}

static NTSTATUS NTAPI hook_free(HANDLE process, PVOID* base, PSIZE_T size, ULONG type) {
  ULONG64 asked = base ? (ULONG64)*base : 0;
  NTSTATUS status = g_free(process, base, size, type);
  int own = own_process(process);
  if (own && base && size) {
    ULONG64 b = status >= 0 ? (ULONG64)*base : asked, e = b + *size;
    ring_call('f', own == 2, status, b, e - b, type, 0);
    if (b && watched(b, e ? e : b + 1)) record_call('f', own == 2, status, b, e - b, type, 0);
  }
  return status;
}

// ntdll's system call stubs begin "mov r10, rcx; mov eax, <number>". The
// original call goes through a copy of that, and the stub jumps to the hook.
static void* hook_stub(HMODULE ntdll, const char* name, void* hook, unsigned char* trampoline) {
  unsigned char* stub = (unsigned char*)GetProcAddress(ntdll, name);
  if (!stub || stub[0] != 0x4C || stub[1] != 0x8B || stub[2] != 0xD1 || stub[3] != 0xB8) return NULL;
  unsigned char tramp[] = {0x4C, 0x8B, 0xD1, 0xB8, stub[4], stub[5], stub[6], stub[7], 0x0F, 0x05, 0xC3};
  memcpy(trampoline, tramp, sizeof(tramp));
  unsigned char patch[12] = {0x48, 0xB8};
  ULONG64 target = (ULONG64)hook;
  memcpy(patch + 2, &target, 8);
  patch[10] = 0xFF;
  patch[11] = 0xE0;
  DWORD old;
  if (!VirtualProtect(stub, sizeof(patch), PAGE_EXECUTE_READWRITE, &old)) return NULL;
  memcpy(stub, patch, sizeof(patch));
  VirtualProtect(stub, sizeof(patch), old, &old);
  FlushInstructionCache(GetCurrentProcess(), stub, sizeof(patch));
  return trampoline;
}

static void install_hooks(void) {
  HMODULE ntdll = GetModuleHandleA("ntdll.dll");
  if (!ntdll) return;
  g_capture = (CaptureFn)GetProcAddress(ntdll, "RtlCaptureStackBackTrace");
  unsigned char* page = (unsigned char*)VirtualAlloc(NULL, 4096, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
  if (!page) return;
  // The trampolines' own page is never watched: allocate it before the hooks.
  g_alloc = (NtAllocFn)(page + 32);
  g_free = (NtFreeFn)(page + 64);
  g_protect = (NtProtectFn)(page + 0);
  g_alloc_ex = (NtAllocExFn)(page + 96);
  int ok = 0;
  ok += hook_stub(ntdll, "NtAllocateVirtualMemoryEx", (void*)hook_alloc_ex, page + 96) != NULL;
  ok += hook_stub(ntdll, "NtAllocateVirtualMemory", (void*)hook_alloc, page + 32) != NULL;
  ok += hook_stub(ntdll, "NtFreeVirtualMemory", (void*)hook_free, page + 64) != NULL;
  ok += hook_stub(ntdll, "NtProtectVirtualMemory", (void*)hook_protect, page + 0) != NULL;
  g_hooked = ok;
}

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
  if (code == EXCEPTION_ACCESS_VIOLATION) {
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)e->info1, &mbi, sizeof(mbi)) == sizeof(mbi)) {
      e->queried = 1;
      e->q_base = (ULONG64)mbi.BaseAddress;
      e->q_alloc_base = (ULONG64)mbi.AllocationBase;
      e->q_size = mbi.RegionSize;
      e->q_alloc_protect = mbi.AllocationProtect;
      e->q_state = mbi.State;
      e->q_protect = mbi.Protect;
      e->q_type = mbi.Type;
    }
  }
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

static char* put_call(char* p, const char* prefix, Call* c) {
  p = put_str(p, prefix);
  *p++ = c->kind;
  if (c->other_handle) p = put_str(p, " (own handle)");
  p = put_str(p, " at "); p = put_hex(p, c->when / 10000);
  p = put_str(p, "ms thread "); p = put_hex(p, c->tid);
  p = put_str(p, " base "); p = put_hex(p, c->base);
  p = put_str(p, " size "); p = put_hex(p, c->size);
  p = put_str(p, " arg "); p = put_hex(p, c->arg);
  p = put_str(p, " old "); p = put_hex(p, c->old);
  p = put_str(p, " status "); p = put_hex(p, (ULONG)c->status);
  p = put_str(p, " frames");
  for (USHORT f = 0; f < c->frame_count && f < CALL_FRAMES; ++f) { *p++ = ' '; p = put_hex(p, c->frames[f]); }
  *p++ = '\n';
  return p;
}

// Checks every page made executable by a protect call. One that stops being
// executable with no recorded call gets the ring's calls around it written out.
static DWORD WINAPI watch_pages(LPVOID unused) {
  static char line[4096];
  for (;;) {
    LONG n = g_page_count;
    if (n > MAX_PAGES) n = MAX_PAGES;
    for (LONG i = 0; i < n; ++i) {
      if (g_page_state[i] != 0) continue;
      MEMORY_BASIC_INFORMATION mbi;
      ULONG64 now = *(volatile ULONG64*)0x7FFE0008;
      if (VirtualQuery((LPCVOID)g_pages[i], &mbi, sizeof(mbi)) != sizeof(mbi)) continue;
      if (mbi.State == MEM_COMMIT && (mbi.Protect & EXEC_MASK)) { g_page_seen[i] = now; continue; }
      // A recorded call may be releasing it right now.
      Sleep(20);
      if (g_page_state[i] != 0) continue;
      InterlockedExchange(&g_page_state[i], 2);
      ULONG64 seen = g_page_seen[i];
      char* p = put_str(line, "changed page "); p = put_hex(p, g_pages[i]);
      p = put_str(p, " seen at "); p = put_hex(p, now / 10000);
      p = put_str(p, "ms, executable at "); p = put_hex(p, seen / 10000);
      p = put_str(p, "ms; now state "); p = put_hex(p, mbi.State);
      p = put_str(p, " protect "); p = put_hex(p, mbi.Protect);
      p = put_str(p, " type "); p = put_hex(p, mbi.Type);
      p = put_str(p, " region "); p = put_hex(p, (ULONG64)mbi.BaseAddress);
      p = put_str(p, "+"); p = put_hex(p, mbi.RegionSize);
      p = put_str(p, " allocation "); p = put_hex(p, (ULONG64)mbi.AllocationBase);
      *p++ = '\n';
      write_out(line, p);
      ULONG64 from = seen > 20000 ? seen - 20000 : 0;
      LONG last = g_ring_next;
      LONG first = last > RING ? last - RING : 0;
      for (LONG r = first; r < last; ++r) {
        Call* c = &g_ring[r & (RING - 1)];
        if (c->state != 1 || c->when < from || c->when > now + 10000) continue;
        p = put_call(line, "  ring ", c);
        write_out(line, p);
      }
    }
    Sleep(1);
  }
  return 0;
}

typedef HRESULT(WINAPI* GetThreadDescriptionFn)(HANDLE, PWSTR*);

static DWORD WINAPI write_records(LPVOID unused) {
  static char line[16384];
  static ULONG64 seen[1024];
  int seen_count = 0;
  LONG written = 0;
  LONG calls_written = 0;
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
    // Memory changes first: a crash waits only for its own record.
    while (calls_written < MAX_CALLS && g_calls[calls_written].state == 1) {
      Call* c = &g_calls[calls_written];
      char* p = put_call(line, "mem ", c);
      write_out(line, p);
      InterlockedExchange(&c->state, 2);
      ++calls_written;
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
      if (e->queried) {
        p = put_str(p, "\n  page base "); p = put_hex(p, e->q_base);
        p = put_str(p, " allocation "); p = put_hex(p, e->q_alloc_base);
        p = put_str(p, " size "); p = put_hex(p, e->q_size);
        p = put_str(p, " allocated as "); p = put_hex(p, e->q_alloc_protect);
        p = put_str(p, " state "); p = put_hex(p, e->q_state);
        p = put_str(p, " protect "); p = put_hex(p, e->q_protect);
        p = put_str(p, " type "); p = put_hex(p, e->q_type);
      }
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

__declspec(dllexport) int veh_installed(void) { return g_installed | (g_hooked << 4); }

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
  if (reason != DLL_PROCESS_ATTACH) return TRUE;
  char path[MAX_PATH];
  DWORD n = GetEnvironmentVariableA("GLOOM_DIAG_VEH_LOG", path, MAX_PATH);
  if (n == 0 || n >= MAX_PATH) return TRUE;
  g_log = CreateFileA(path, FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  if (g_log == INVALID_HANDLE_VALUE) return TRUE;
  if (GetEnvironmentVariableA("GLOOM_DIAG_VEH_MEMORY", NULL, 0)) install_hooks();
  char hello[96];
  char* p = put_str(hello, "installed in pid ");
  p = put_hex(p, GetCurrentProcessId());
  p = put_str(p, " memory hooks "); p = put_hex(p, g_hooked);
  *p++ = '\n';
  write_out(hello, p);
  if (AddVectoredExceptionHandler(1, record_exception)) g_installed = 1;
  CreateThread(NULL, 1 << 20, write_records, NULL, 0, NULL);
  if (g_hooked) CreateThread(NULL, 1 << 20, watch_pages, NULL, 0, NULL);
  return TRUE;
}
