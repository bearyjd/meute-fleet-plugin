// The operator's repo choice, kept on this client only: in memory, plus the host's localStorage
// when it has one (best effort). Nothing is sent to the daemon and nothing is written to Meute.
import { isSafeName } from "../shared/validate";
import { MAX_PICKED_REPOS, parseStoredRepos } from "./viewmodel";

const KEY = "meute-fleet.repos";

export interface RepoStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function createRepoSelectionStore(storage: RepoStorage | undefined) {
  const read = (): string[] => {
    try {
      return storage ? parseStoredRepos(storage.getItem(KEY)) : [];
    } catch {
      return [];
    }
  };
  let current: readonly string[] = read();
  const listeners = new Set<() => void>();
  return {
    get: (): readonly string[] => current,
    set(next: readonly string[]) {
      current = [...new Set(next.filter((repo) => isSafeName(repo)))].slice(0, MAX_PICKED_REPOS);
      try {
        storage?.setItem(KEY, JSON.stringify(current));
      } catch {
        // Persistence is optional: the choice still holds for this session.
      }
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

const host = (globalThis as { localStorage?: RepoStorage }).localStorage;
export const repoSelection = createRepoSelectionStore(host);
