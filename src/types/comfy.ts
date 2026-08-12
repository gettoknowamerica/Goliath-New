// Types for the ComfyUI HTTP API (owner's GPU box via Cloudflare quick tunnel).
export interface ComfySystemStats {
  system?: {
    os?: string;
    comfyui_version?: string;
  };
  devices?: Array<{
    name?: string;
    vram_total?: number;
    vram_free?: number;
  }>;
}

export interface ComfyQueueState {
  queue_running: Array<[number, string]>;
  queue_pending: Array<[number, string]>;
}

export interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
  format?: string;
}

export interface ComfyNodeOutput {
  images?: ComfyOutputFile[];
  video?: ComfyOutputFile[];
}

export type ComfyWorkflowOutputs = Record<string, ComfyNodeOutput>;

export interface ComfyHistoryEntry {
  prompt?: unknown;
  outputs?: ComfyWorkflowOutputs;
  status?: {
    status_str?: string;
    completed?: boolean;
    messages?: unknown[];
  };
}
