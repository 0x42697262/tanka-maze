/** Reusable object pool for simulation objects that churn every tick. */
export class ObjectPool<T> {
  private readonly free: T[] = [];

  constructor(
    private readonly create: () => T,
    private readonly reset: (item: T) => void = () => {},
    initialSize = 0
  ) {
    for (let i = 0; i < initialSize; i++) this.free.push(this.create());
  }

  acquire(): T {
    return this.free.pop() ?? this.create();
  }

  release(item: T): void {
    this.reset(item);
    this.free.push(item);
  }
}
