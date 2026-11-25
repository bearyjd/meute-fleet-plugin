// Minimal typing for react-test-renderer (its @types package is not available offline).
declare module "react-test-renderer" {
  import type { ReactElement } from "react";
  export interface TestInstance {
    readonly type: unknown;
    readonly props: Record<string, unknown>;
    findAll(predicate: (node: TestInstance) => boolean): TestInstance[];
  }
  export interface Renderer {
    readonly root: TestInstance;
    update(element: ReactElement): void;
    unmount(): void;
  }
  export function act(callback: () => void | Promise<void>): Promise<void>;
  const TestRenderer: { create(element: ReactElement): Renderer };
  export default TestRenderer;
}
