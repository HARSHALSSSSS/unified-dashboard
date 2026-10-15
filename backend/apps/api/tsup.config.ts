import { defineConfig } from 'tsup';
// @ts-expect-error plain JS helper shared by all apps
import { appConfig } from '../../scripts/tsup-app.mjs';

export default defineConfig(appConfig(import.meta.dirname));
