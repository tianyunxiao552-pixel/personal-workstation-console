import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
export default defineConfig({
  base:'/app/',plugins:[{name:'native-production-controls',enforce:'pre',resolveId(source,importer){if(source==='./mobile'&&importer&&/[\\/]src[\\/][^\\/]+\.tsx$/.test(importer))return path.resolve('src/native-mobile.tsx');}},react()],
  publicDir:'native-public',build:{outDir:'dist/native',emptyOutDir:true,rollupOptions:{input:path.resolve('app.html')}}
});
