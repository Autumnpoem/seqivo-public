import { defineConfig } from 'vite';
export default defineConfig({base:'./',server:{host:'127.0.0.1',proxy:{'/api':'http://127.0.0.1:4317'}},build:{target:'es2022'}});
