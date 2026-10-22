/** Data contract between the update interface and native update service. */
export interface UpdateRelease {
  version: string;
  releaseNotes: string;
  publishedAt: string;
}

export interface UpdateCheck {
  currentVersion: string;
  channel: "standalone" | "byok" | "store";
  available: boolean;
  release: UpdateRelease | null;
}

export interface UpdateProgress {
  stage: "downloading" | "ready" | "installing";
  downloadedBytes: number;
  totalBytes: number | null;
}

export interface UpdateServices {
  check(): Promise<UpdateCheck>;
  download(): Promise<void>;
  install(): Promise<void>;
  onProgress(listener: (progress: UpdateProgress) => void): Promise<() => void>;
}
