import { defineConfig } from 'vite';

export default defineConfig({
    esbuild: {
        // Required for tsyringe: support legacy decorators + metadata reflection
        target: 'es2022',
        tsconfigRaw: {
            compilerOptions: {
                experimentalDecorators: true,
                emitDecoratorMetadata: true,
            },
        },
    },
});
