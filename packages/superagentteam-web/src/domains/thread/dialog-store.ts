import { create } from "zustand";

export interface NewThreadDialogState {
	open: boolean;
	show(): void;
	hide(): void;
}

export const useNewThreadDialog = create<NewThreadDialogState>((set) => ({
	open: false,
	show: () => set({ open: true }),
	hide: () => set({ open: false }),
}));
