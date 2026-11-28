import { dlopen, FFIType, ptr } from "bun:ffi";
import { join } from "node:path";
import { attributeListeners, decodeListeners, PortSampleError } from "./ports";

const { ptr: pointer, u32, u64, i32, void: noResult } = FFIType;
const ERROR_MORE_DATA = 234;
const ERROR_INSUFFICIENT_BUFFER = 122;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const JOB_BASIC_ACCOUNTING = 1;
const JOB_PROCESS_ID_LIST = 3;
const JOB_EXTENDED_LIMIT = 9;
const JOB_KILL_ON_CLOSE = 0x2000;
const PROC_THREAD_ATTRIBUTE_HANDLE_LIST = 0x20002n;
const PROC_THREAD_ATTRIBUTE_JOB_LIST = 0x2000dn;
const EXTENDED_STARTUPINFO_PRESENT = 0x80000;
const CREATE_UNICODE_ENVIRONMENT = 0x400;
const STARTF_USESTDHANDLES = 0x100;
const STARTUPINFOEX_SIZE = 112;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
const SYNCHRONIZE = 0x100000;
const WAIT_OBJECT_0 = 0;
const WAIT_TIMEOUT = 258;
const TCP_TABLE_OWNER_MODULE_LISTENER = 6;

const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");

/** Starts the installed launcher in a fresh job before it can create any descendants. */
export function launchForPorts(bin: string, out: string, env: NodeJS.ProcessEnv) {
  const kernel = dlopen("kernel32.dll", {
    GetLastError: { args: [], returns: u32 },
    CreateJobObjectW: { args: [pointer, pointer], returns: u64 },
    SetInformationJobObject: { args: [u64, i32, pointer, u32], returns: i32 },
    QueryInformationJobObject: { args: [u64, i32, pointer, u32, pointer], returns: i32 },
    TerminateJobObject: { args: [u64, u32], returns: i32 },
    CloseHandle: { args: [u64], returns: i32 },
    CreateFileW: { args: [pointer, u32, u32, pointer, u32, u32, u64], returns: u64 },
    InitializeProcThreadAttributeList: { args: [pointer, u32, u32, pointer], returns: i32 },
    UpdateProcThreadAttribute: { args: [pointer, u32, u64, pointer, u64, pointer, pointer], returns: i32 },
    DeleteProcThreadAttributeList: { args: [pointer], returns: noResult },
    CreateProcessW: { args: [pointer, pointer, pointer, pointer, i32, u32, pointer, pointer, pointer, pointer], returns: i32 },
    OpenProcess: { args: [u32, i32, u32], returns: u64 },
    IsProcessInJob: { args: [u64, u64, pointer], returns: i32 },
    GetProcessTimes: { args: [u64, pointer, pointer, pointer, pointer], returns: i32 },
    WaitForSingleObject: { args: [u64, u32], returns: u32 },
  });
  const { symbols: win } = kernel;
  let job = 0n;
  const fail = (operation: string): never => {
    throw new PortSampleError(`${operation} (Windows error ${win.GetLastError()})`);
  };

  function start(): void {
    job = win.CreateJobObjectW(null, null);
    if (!job) fail("Could not create the launch job");
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(JOB_KILL_ON_CLOSE, 16);
    if (!win.SetInformationJobObject(job, JOB_EXTENDED_LIMIT, ptr(limits), limits.length)) fail("Could not configure launch cleanup");

    const security = Buffer.alloc(24);
    security.writeUInt32LE(security.length, 0);
    security.writeUInt32LE(1, 16);
    const handles: bigint[] = [];
    const attributeSize = Buffer.alloc(8);
    win.InitializeProcThreadAttributeList(null, 2, 0, ptr(attributeSize));
    const attributes = Buffer.alloc(Number(attributeSize.readBigUInt64LE()));
    if (!attributes.length || !win.InitializeProcThreadAttributeList(ptr(attributes), 2, 0, ptr(attributeSize))) fail("Could not initialize launch attributes");
    try {
      for (const [path, writing] of [["NUL", false], [join(out, "app-stdout.log"), true], [join(out, "app-stderr.log"), true]] as const) {
        const handle = win.CreateFileW(ptr(wide(path)), writing ? 0x40000000 : 0x80000000, 3, ptr(security), writing ? 2 : 3, 0x80, 0n);
        if (handle === INVALID_HANDLE_VALUE) fail("Could not open launch standard streams");
        handles.push(handle);
      }
      const startup = Buffer.alloc(STARTUPINFOEX_SIZE + 8);
      startup.writeUInt32LE(STARTUPINFOEX_SIZE, 0);
      startup.writeUInt32LE(STARTF_USESTDHANDLES, 60);
      handles.forEach((handle, index) => startup.writeBigUInt64LE(handle, 80 + 8 * index));
      startup.writeBigUInt64LE(BigInt(ptr(attributes)), 104);
      startup.writeBigUInt64LE(job, STARTUPINFOEX_SIZE);
      if (!win.UpdateProcThreadAttribute(ptr(attributes), 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, ptr(startup, 80), 24n, null, null) ||
          !win.UpdateProcThreadAttribute(ptr(attributes), 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, ptr(startup, STARTUPINFOEX_SIZE), 8n, null, null)) {
        fail("Could not set launch attributes");
      }

      const processInfo = Buffer.alloc(24);
      const launcher = join(bin, "launcher.exe");
      const executable = wide(launcher);
      const command = wide(`"${launcher}"`);
      const cwd = wide(bin);
      const entries = new Map(Object.entries(env).flatMap(([key, value]) =>
        value === undefined ? [] : [[key.toUpperCase(), `${key}=${value}\0`] as const]));
      const environment = wide([...entries.keys()].sort().map((key) => entries.get(key)).join(""));
      if (!win.CreateProcessW(ptr(executable), ptr(command), null, null, 1,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, ptr(environment), ptr(cwd), ptr(startup), ptr(processInfo))) {
        fail("Could not start the installed launcher in its job");
      }
      win.CloseHandle(processInfo.readBigUInt64LE(8));
      win.CloseHandle(processInfo.readBigUInt64LE(0));
    } finally {
      win.DeleteProcThreadAttributeList(ptr(attributes));
      for (const handle of handles) win.CloseHandle(handle);
    }
  }

  function accounting() {
    const data = Buffer.alloc(48);
    if (!win.QueryInformationJobObject(job, JOB_BASIC_ACCOUNTING, ptr(data), data.length, null)) fail("Could not read launch accounting");
    return { assigned: data.readUInt32LE(36), active: data.readUInt32LE(40) };
  }

  function membership() {
    const { assigned, active } = accounting();
    const data = Buffer.alloc(8 + 8 * Math.max(1, active));
    if (!win.QueryInformationJobObject(job, JOB_PROCESS_ID_LIST, ptr(data), data.length, null)) {
      if (win.GetLastError() === ERROR_MORE_DATA) throw new PortSampleError("Launch membership changed during collection");
      fail("Could not read launch membership");
    }
    const count = data.readUInt32LE(4);
    const current = accounting();
    if (data.readUInt32LE(0) !== count || count !== active || current.assigned !== assigned || current.active !== active) {
      throw new PortSampleError("Launch membership changed during collection");
    }
    return { assigned, pids: Array.from({ length: count }, (_, index) => Number(data.readBigUInt64LE(8 + 8 * index))) };
  }

  function member(pid: number, handles: bigint[]) {
    const handle = win.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, 0, pid);
    if (!handle) fail("Could not open a launch member for attribution");
    handles.push(handle);
    const inJob = Buffer.alloc(4);
    if (!win.IsProcessInJob(handle, job, ptr(inJob))) fail("Could not confirm launch membership");
    if (!inJob.readUInt32LE()) throw new PortSampleError("A launch member changed identity during collection");
    const times = Buffer.alloc(32);
    if (!win.GetProcessTimes(handle, ptr(times), ptr(times, 8), ptr(times, 16), ptr(times, 24))) fail("Could not read a launch member's creation time");
    return { pid, created: times.readBigUInt64LE() };
  }

  function sample() {
    const ip = dlopen("iphlpapi.dll", {
      GetExtendedTcpTable: { args: [pointer, pointer, i32, u32, i32, u32], returns: u32 },
    });
    const handles: bigint[] = [];
    try {
      function listeners(family: 4 | 6) {
        const size = Buffer.alloc(4);
        let table: Buffer | undefined;
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const code = ip.symbols.GetExtendedTcpTable(table ? ptr(table) : null, ptr(size), 0, family === 4 ? 2 : 23, TCP_TABLE_OWNER_MODULE_LISTENER, 0);
          if (code === 0 && table) {
            const length = size.readUInt32LE();
            if (length > table.length) throw new PortSampleError(`Invalid IPv${family} listener table length`);
            return decodeListeners(table.subarray(0, length), family);
          }
          if (code !== ERROR_INSUFFICIENT_BUFFER) throw new PortSampleError(`Could not read the IPv${family} listener table (Windows error ${code})`);
          table = Buffer.alloc(size.readUInt32LE());
        }
        throw new PortSampleError(`The IPv${family} listener table did not settle`);
      }
      const before = membership();
      const members = before.pids.map((pid) => member(pid, handles));
      const rows = [...listeners(4), ...listeners(6)];
      const after = membership();
      for (const handle of handles) {
        const state = win.WaitForSingleObject(handle, 0);
        if (state === WAIT_OBJECT_0) throw new PortSampleError("A launch member exited during the listener sample");
        if (state !== WAIT_TIMEOUT) fail("Could not verify that a launch member stayed alive");
      }
      return attributeListeners(before, members, rows, after);
    } finally {
      for (const handle of handles) win.CloseHandle(handle);
      ip.close();
    }
  }

  async function close(): Promise<void> {
    try {
      if (!win.TerminateJobObject(job, 1)) fail("Could not terminate the isolated launch");
      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (!accounting().active) return;
        await Bun.sleep(100);
      }
      throw new PortSampleError("The isolated launch did not stop in time");
    } finally {
      win.CloseHandle(job);
      kernel.close();
    }
  }

  try {
    start();
    return { sample, close };
  } catch (error) {
    if (job) win.CloseHandle(job);
    kernel.close();
    throw error;
  }
}
