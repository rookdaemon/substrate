export interface FileStat {
  mtimeMs: number;
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export interface IFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
  appendFile(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<FileStat>;
  readdir(path: string): Promise<string[]>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(src: string, dest: string): Promise<void>;
  unlink(path: string): Promise<void>;
}
