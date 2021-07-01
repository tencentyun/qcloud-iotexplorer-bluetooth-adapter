export class SimpleStore<T> {
  filter: (params: Partial<T>) => (target: T) => boolean;
  _store: T[] = [];

  constructor({
    filter,
  }: {
    filter: (params: Partial<T>) => (target: T) => boolean;
  }) {
    this.filter = filter;
  }

  getAll() {
    return this._store;
  }

  get(params: Partial<T>): T {
    return this._store.find(this.filter(params));
  }

  set(target: T): number {
    let index = this._store.findIndex(this.filter(target));

    if (index > -1) {
      this._store[index] = target;
    } else {
      this._store.push(target);
      index = this._store.length - 1;
    }

    return index;
  }

  remove(params: Partial<T>) {
    let index = this._store.findIndex(this.filter(params));

    if (index > -1) {
      this._store.splice(index, 1);
    }
  }

  clear() {
    this._store = [];
  }
}
