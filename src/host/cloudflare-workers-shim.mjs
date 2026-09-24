// Minimal stand-in for `cloudflare:workers` under plain Node. The ported Worker code
// imports only the `DurableObject` base class from that module; the host supplies the
// context and environment that Cloudflare would otherwise construct around the subclass.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
