import { Effect } from "effect";
import { Terminal } from "@effect/platform";
import type { GroupMetadata } from "./groups";

const ANSI = {
	CLEAR_SCREEN: "\x1b[2J\x1b[H",
	CURSOR_HIDE: "\x1b[?25l",
	CURSOR_SHOW: "\x1b[?25h",
	RESET: "\x1b[0m",
	BRIGHT: "\x1b[1m",
	DIM: "\x1b[2m",
	GREEN: "\x1b[32m",
	CYAN: "\x1b[36m",
	ARROW: "→",
} as const;

const renderGroupSelector = (
	groups: ReadonlyArray<GroupMetadata>,
	selectedIndex: number,
): string => {
	const lines: string[] = [];

	lines.push(ANSI.CLEAR_SCREEN);
	lines.push(`${ANSI.BRIGHT}${ANSI.CYAN}Selecciona un grupo de WhatsApp para monitorear:${ANSI.RESET}`);
	lines.push("");
	lines.push(`${ANSI.DIM}Usa las flechas ↑/↓ para navegar, Enter para seleccionar${ANSI.RESET}`);
	lines.push("");
	lines.push(`${ANSI.DIM}─${"─".repeat(60)}${ANSI.RESET}`);

	const maxVisible = Math.min(groups.length, 12);
	const startIdx = Math.max(
		0,
		Math.min(selectedIndex - Math.floor(maxVisible / 2), groups.length - maxVisible),
	);

	for (let i = startIdx; i < Math.min(startIdx + maxVisible, groups.length); i++) {
		const group = groups[i];
		if (!group) continue;

		const isSelected = i === selectedIndex;
		const prefix = isSelected ? `${ANSI.GREEN}${ANSI.ARROW}${ANSI.RESET}` : " ";
		const name = isSelected
			? `${ANSI.BRIGHT}${ANSI.GREEN}${group.subject}${ANSI.RESET}`
			: group.subject;

		lines.push(`${prefix} ${name}`);
		lines.push(
			`   ${ANSI.DIM}JID: ${group.id} • Miembros: ${group.participantCount}${ANSI.RESET}`,
		);
	}

	if (groups.length > maxVisible) {
		lines.push("");
		lines.push(
			`${ANSI.DIM}Mostrando ${startIdx + 1}-${Math.min(startIdx + maxVisible, groups.length)} de ${groups.length} grupos${ANSI.RESET}`,
		);
	}

	lines.push(`${ANSI.DIM}─${"─".repeat(60)}${ANSI.RESET}`);

	return lines.join("\n") + "\n";
};

const display = (message: string) =>
	Effect.gen(function* () {
		const terminal = yield* Terminal.Terminal;
		yield* terminal.display(message);
	});

const isNavigationKey = (key: Terminal.Key): boolean =>
	key.name === "up" || key.name === "down" || key.name === "k" || key.name === "j";

const isSelectKey = (key: Terminal.Key): boolean =>
	key.name === "return" || key.name === "enter";

const isCancelKey = (key: Terminal.Key): boolean =>
	key.name === "escape" || (key.name === "c" && key.ctrl);

const runSelectorLoop = (
	groups: ReadonlyArray<GroupMetadata>,
) => Effect.gen(function* () {
	let selectedIndex = 0;

	yield* display(renderGroupSelector(groups, selectedIndex));

	const terminal = yield* Terminal.Terminal;
	const inputMailbox = yield* terminal.readInput;

	while (true) {
		const userInput = yield* inputMailbox.take;
		const key = userInput.key;

		if (isNavigationKey(key)) {
			if (key.name === "up" || key.name === "k") {
				selectedIndex = (selectedIndex - 1 + groups.length) % groups.length;
			} else {
				selectedIndex = (selectedIndex + 1) % groups.length;
			}
			yield* display(ANSI.CLEAR_SCREEN + renderGroupSelector(groups, selectedIndex));
		} else if (isSelectKey(key)) {
			const selectedGroup = groups[selectedIndex];
			if (selectedGroup) {
				yield* display(
					`\n\n${ANSI.BRIGHT}${ANSI.GREEN}Seleccionado:${ANSI.RESET} ${selectedGroup.subject}\n`,
				);
				yield* display(`${ANSI.DIM}JID: ${selectedGroup.id}${ANSI.RESET}\n\n`);
				return selectedGroup;
			}
		} else if (isCancelKey(key)) {
			yield* display("\n\nSelección cancelada.\n\n");
			return yield* Effect.fail(new Error("User cancelled selection"));
		}
	}

	// TypeScript control flow analysis - this is never reached
	return yield* Effect.fail(new Error("Unexpected exit from selector loop"));
});

const selectGroupInteractively = (
	groups: ReadonlyArray<GroupMetadata>,
): Effect.Effect<GroupMetadata, Error, Terminal.Terminal> => {
	if (groups.length === 0) {
		return Effect.fail(new Error("No hay grupos disponibles"));
	}

	const firstGroup = groups[0];
	if (groups.length === 1 && firstGroup) {
		return Effect.gen(function* () {
			yield* Effect.logInfo(`Solo se encontró un grupo, seleccionando automáticamente: ${firstGroup.subject}`);
			return firstGroup;
		});
	}

	return Effect.scoped(
		Effect.mapError(
			runSelectorLoop(groups),
			(error) => error instanceof Error ? error : new Error(String(error)),
		),
	);
};

export type { GroupMetadata };
export { selectGroupInteractively };
