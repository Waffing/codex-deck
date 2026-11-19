interface QueuedTurn { id: string; run: () => Promise<void> }

export class WorkspaceQueue {
  private waiting = new Map<string, QueuedTurn[]>();
  private active = new Map<string, Promise<void>>();
  private stopped = false;

  enqueue(workspace: string, item: QueuedTurn) {
    if (this.stopped) throw new Error("Queue is closed.");
    const queue = this.waiting.get(workspace) ?? [];
    queue.push(item);
    this.waiting.set(workspace, queue);
    this.next(workspace);
  }

  remove(id: string): boolean {
    for (const queue of this.waiting.values()) {
      const i = queue.findIndex(item => item.id === id);
      if (i >= 0) { queue.splice(i, 1); return true; }
    }
    return false;
  }

  private next(workspace: string) {
    if (this.stopped || this.active.has(workspace)) return;
    const queue = this.waiting.get(workspace);
    const item = queue?.shift();
    if (!queue?.length) this.waiting.delete(workspace);
    if (!item) return;
    const running = Promise.resolve().then(item.run).finally(() => {
      this.active.delete(workspace);
      this.next(workspace);
    });
    this.active.set(workspace, running);
  }

  stop() { this.stopped = true; this.waiting.clear(); }
  async drain() { await Promise.allSettled([...this.active.values()]); }
}
