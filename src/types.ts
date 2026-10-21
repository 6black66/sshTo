export interface Device {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: "password" | "key";
  keyPath: string;
  jumps: string[];
  hasSecret?: boolean;
  savedSecret?: boolean;
}
export interface Session {
  id: string;
  deviceId: string;
  route: { id: string; name: string; host: string }[];
  status: string;
  hop?: number;
  message?: string;
  sftp?: boolean;
  sftpMessage?: string;
}
export interface Entry {
  name: string;
  directory: boolean;
  symlink: boolean;
  size: number;
}
export interface Listing {
  path: string;
  entries: Entry[];
}
export interface Task {
  id: string;
  sessionId: string;
  direction: string;
  sources: string[];
  destination: string;
  status: string;
  bytes: number;
  total: number;
  started?: number;
  current?: string;
  message?: string;
}
export interface SSHEvent {
  type: string;
  id: string;
  data?: string;
  status?: string;
  hop?: number;
  message?: string;
  available?: boolean;
  task?: Task;
}
declare global {
  interface Window {
    sshTo: {
      call<T = unknown>(name: string, ...args: unknown[]): Promise<T>;
      subscribe(fn: (event: SSHEvent) => void): () => void;
    };
  }
}
export const api = <T = unknown>(name: string, ...args: unknown[]) =>
  window.sshTo.call<T>(name, ...args);
