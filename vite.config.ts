import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/home-energy/', // 레포 이름과 정확히 일치 (앞뒤 슬래시 포함)
})
