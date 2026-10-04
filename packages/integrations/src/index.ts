// One adapter per provider in ./<provider>/, implementing the shared interface
// in ./adapter.ts. Nango integration functions live in ../nango-integrations/.
export {
  type ActionAdapter,
  type AdapterConnection,
  AdapterError,
  type AdapterRegistry,
  adapterFor,
  type ExecuteRequest,
  type ExecuteResponse,
} from './adapter.ts';
