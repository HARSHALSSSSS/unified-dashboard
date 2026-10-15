import { effects, opCtxFromRequest, systemOpCtx, type OpCtx, type OpEffects } from '@oms/module-kit';

/** Listing use-cases open their own short transactions (they call marketplaces in between), so they take an OpCtx instead of a request. */
export type Ctx = OpCtx;
export type Fx = OpEffects;
export const ctxFromRequest = opCtxFromRequest;
export const systemCtx = (c: OpCtx['c'], vendorId: string, who = 'listings'): Ctx => systemOpCtx(c, vendorId, who);
export const fx = effects;
