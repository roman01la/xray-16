// Nonblocking query readback. Generation checks prevent a pooled engine query
// from receiving the result of its previous use.
export class OcclusionQueries {
  constructor(device, capacity = 4096) {
    this.device = device;
    this.capacity = capacity;
    this.records = [];
    this.slots = [];
    this.set = device.createQuerySet({ type: "occlusion", count: capacity });
    this.resolveBuffer = device.createBuffer({
      size: capacity * 8,
      usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
    });
    this.active = null;
    this.open = false;
  }
  begin(pass, query) {
    if (this.active) throw Error("Nested occlusion queries");
    query.generation = (query.generation || 0) + 1;
    query.available = false;
    this.active = { query, generation: query.generation };
    this.resume(pass);
  }
  resume(pass) {
    if (!this.active || this.open) return;
    if (this.records.length === this.capacity)
      throw Error("Occlusion query capacity exceeded");
    pass.beginOcclusionQuery(this.records.length);
    this.records.push(this.active);
    this.open = true;
  }
  suspend(pass) {
    if (this.open) {
      pass.endOcclusionQuery();
      this.open = false;
    }
  }
  end(pass) {
    this.suspend(pass);
    this.active = null;
  }
  resolve(encoder) {
    if (!this.records.length) return null;
    let slot = this.slots.find((s) => !s.busy);
    if (!slot) {
      slot = {
        buffer: this.device.createBuffer({
          size: this.capacity * 8,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        }),
        busy: false,
      };
      this.slots.push(slot);
    }
    slot.busy = true;
    const records = this.records.splice(0),
      size = records.length * 8;
    encoder.resolveQuerySet(this.set, 0, records.length, this.resolveBuffer, 0);
    encoder.copyBufferToBuffer(this.resolveBuffer, 0, slot.buffer, 0, size);
    return async () => {
      try {
        await slot.buffer.mapAsync(GPUMapMode.READ, 0, size);
        const values = new BigUint64Array(slot.buffer.getMappedRange(0, size)),
          totals = new Map();
        for (let i = 0; i < records.length; i++) {
          const r = records[i];
          if (!r.query.deleted && r.query.generation === r.generation)
            totals.set(r.query, (totals.get(r.query) || 0n) + values[i]);
        }
        for (const [query, value] of totals) {
          query.result = value > 0n ? 1 : 0;
          query.available = true;
        }
        slot.buffer.unmap();
      } finally {
        if (slot.buffer.mapState === "mapped") slot.buffer.unmap();
        slot.busy = false;
      }
    };
  }
}
