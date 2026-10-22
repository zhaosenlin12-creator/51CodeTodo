import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UpdateCheck, UpdateProgress, UpdateServices } from "../contracts/updates";

export const updateServices: UpdateServices = {
  check: () => invoke<UpdateCheck>("pometodo_check_update"),
  download: () => invoke<void>("pometodo_download_update"),
  install: () => invoke<void>("pometodo_install_update"),
  onProgress: (listener) => listen<UpdateProgress>("pometodo-update-progress", event => listener(event.payload)),
};
