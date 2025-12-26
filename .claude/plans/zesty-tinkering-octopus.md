# Fix: Baileys v7 messages.upsert Event Structure

## Problem
After scanning QR code and connecting successfully, the app crashes with:
```
TypeError: messages is not iterable
    at processMessages (/src/connection.ts:54:24)
```

## Root Cause
Baileys v7 changed the `messages.upsert` event structure. It's now an object with:
- `messages: WAMessage[]` - the actual array of messages
- `type: string` - the message upsert type

Our code treats the event as a direct array, but it's an object containing an array.

## Fix

**File: `src/connection.ts`**

1. Update `processMessages` to extract the messages array from the event:
```ts
const processMessages = (
	event: BaileysEventMap["messages.upsert"],
	handler: (message: WAMessage) => void,
): void => {
	for (const message of event.messages) {
		handler(message);
	}
};
```

2. Update the callback type:
```ts
type ConnectionCallbacks = {
	onStateChange: (state: ConnectionState) => void;
	onConnected: (socket: WASocket) => void;
	onMessage: (message: WAMessage) => void;  // Changed from BaileysEventMap["messages.upsert"][number]
	onReconnect: () => void;
};
```

3. Add the import for `WAMessage` type if needed.
