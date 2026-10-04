/** Stands in for `cloudflare:workers` under Node: the base class keeps the host-provided ctx and env. */
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
