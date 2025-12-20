import { configureStore } from "@reduxjs/toolkit";

// Placeholder root reducer.
// We'll add feature reducers here as the app grows.
const rootReducer = (state: Record<string, never> = {}) => state;

export const store = configureStore({
  reducer: rootReducer,
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
