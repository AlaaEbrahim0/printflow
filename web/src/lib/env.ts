/** `npm run dev:mock` sets VITE_USE_MOCKS=true through `.env.mock` (mode "mock"). */
export const IS_MOCK = import.meta.env.VITE_USE_MOCKS === 'true'

export const CONTRACT_VERSION = '1.0.0'
