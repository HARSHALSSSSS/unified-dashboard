import { manifest } from './manifest';
import { vendorRoutes } from './routes';

export { manifest };
export { vendorRoutes };
export { getVendor, toVendorDto, type VendorRow } from './service';

/** Vendor / Organization: tenant root, business profile, settings and platform-level status administration. */
export const vendorsModule = { manifest, routes: vendorRoutes };
