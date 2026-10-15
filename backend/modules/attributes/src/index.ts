import { manifest } from './manifest';
import { attributeRoutes } from './routes';

export { manifest };
export { attributeRoutes };
export {
  setProductAttributeValues, getProductAttributeValues, requiredAttributesForCategory,
  type ProductValueInput, type RawValue, type AttributeType,
} from './service';

/**
 * Attributes: generic attribute definitions + allowed values + category assignments + typed product values.
 * Marketplace-specific attributes are intentionally NOT modelled here.
 */
export const attributesModule = { manifest, routes: attributeRoutes };
