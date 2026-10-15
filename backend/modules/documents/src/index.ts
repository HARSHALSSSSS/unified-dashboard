import { manifest } from './manifest';
import { documentRoutes } from './routes';

export { manifest };
export { documentRoutes };

/**
 * Documents & Media: product images, documents and listing documents. Bytes live in object storage behind the
 * `ObjectStorage` port (S3/MinIO/memory...); this module owns metadata, validation (type, size, content sniffing),
 * primary-image rules and short-lived download URLs.
 */
export const documentsModule = { manifest, routes: documentRoutes };
