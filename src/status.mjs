import { StateStore } from './state.mjs';
const account = new StateStore().read();
console.log(JSON.stringify({ logged_in: !!account?.token, owner_bound: !!account?.ownerId, context_ready: !!account?.contextToken }, null, 2));
