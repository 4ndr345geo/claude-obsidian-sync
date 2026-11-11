import {
	App,
	debounce,
	FuzzySuggestModal,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	Setting,
	TAbstractFile,
	TFile,
} from "obsidian";
import { hasConflictMarkers } from "./merge";
import qrcode from "qrcode-generator";
import { authorizeDesktop, exportConnection, importConnection } from "./auth";
import { ConfigSyncOptions } from "./config";
import { addEntry, formatDateTime, formatEntry, logPath, makeLogMatcher } from "./log";
import type { BackupEntry } from "./backup";
import { Credentials, DriveClient, DriveError } from "./drive";
import type { FailureEntry } from "./isolation";
import { isSafeSyncPath } from "./paths";
import { newInstallId, SecretStore } from "./secrets";
import { MassDeleteError, SyncEngine, SyncResult, SyncState } from "./sync";

interface Settings {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
	folderName: string;
	deviceName: string;
	autoSyncMinutes: number;
	syncOnStartup: boolean;
	syncAfterEdit: boolean;
	syncOnResume: boolean;
	excludes: string;
	showNotices: boolean;
	config: ConfigSyncOptions;
	logEnabled: boolean;
	logFolder: string;
	/** Random id of this installation; part of the keychain entry names. */
	installId: string;
	backupEnabled: boolean;
	backupKeepDays: number;
	backupMaxMB: number;
}

interface PluginData {
	settings: Settings;
	state: SyncState;
}

function defaultDeviceName(): string {
	if (Platform.isDesktopApp) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			return (require("os") as typeof import("os")).hostname();
		} catch {
			return "Computer";
		}
	}
	if (Platform.isIosApp) return Platform.isTablet ? "iPad" : "iPhone";
	if (Platform.isAndroidApp) return Platform.isTablet ? "Android-Tablet" : "Android-Handy";
	return "Gerät";
}

export default class DriveSyncPlugin extends Plugin {
	settings!: Settings;
	state!: SyncState;
	drive!: DriveClient;
	engine!: SyncEngine;

	private syncing = false;
	private pending = false;
	private lastSync = 0;
	private lastError = "";
	private statusEl!: HTMLElement;
	private intervalId: number | null = null;
	private secrets!: SecretStore;
	/** A sync was stopped because it would delete very many files; waits for the user. */
	private massDelete: MassDeleteError | null = null;
	/** The user confirmed the deletions for the next run only. */
	private massDeleteConfirmed = false;
	private offline = false;
	/** Login no longer valid: automatic syncs pause until the user reconnects or syncs manually. */
	private authBroken = false;
	/** Last error shown for an automatic sync – the same error is not reported every two minutes. */
	private lastReported = "";

	async onload() {
		await this.loadAll();

		this.drive = new DriveClient(() => ({
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
			refreshToken: this.settings.refreshToken,
		}));
		this.engine = new SyncEngine(
			this.app,
			this.drive,
			this.state,
			() => ({
				folderName: this.settings.folderName,
				deviceName: this.settings.deviceName,
				excludes: this.settings.excludes.split("\n"),
				config: this.settings.config,
				backup: {
					enabled: this.settings.backupEnabled,
					keepDays: this.settings.backupKeepDays,
					maxTotalBytes: this.settings.backupMaxMB * 1024 * 1024,
					maxFileBytes: Math.min(50, this.settings.backupMaxMB / 4) * 1024 * 1024,
				},
				// The logs of other devices change all the time; their old versions are not worth keeping.
				skipBackup: (p) => this.isLogFile(p),
			}),
			`${this.app.vault.configDir}/plugins/${this.manifest.id}/base`,
			() => this.saveAll(),
			this.manifest.id
		);

		this.addRibbonIcon("refresh-cw", "Mit Google Drive synchronisieren", () => this.sync(true));
		this.addCommand({
			id: "sync-now",
			name: "Jetzt mit Google Drive synchronisieren",
			callback: () => this.sync(true),
		});

		this.addCommand({
			id: "open-log",
			name: "Sync-Protokoll dieses Geräts öffnen",
			callback: () => this.openLog(),
		});
		this.addCommand({
			id: "restore-backup",
			name: "Frühere Version aus lokaler Sicherung wiederherstellen",
			callback: () => this.showBackups(),
		});
		this.addCommand({
			id: "restore-backup-current",
			name: "Frühere Versionen dieser Datei anzeigen",
			checkCallback: (checking) => {
				const f = this.app.workspace.getActiveFile();
				if (!f) return false;
				if (!checking) void this.showBackups(f.path);
				return true;
			},
		});
		this.addCommand({
			id: "show-failures",
			name: "Dateien mit Sync-Fehlern anzeigen",
			callback: () => this.showFailures(),
		});
		this.addCommand({
			id: "show-conflicts",
			name: "Notizen mit Sync-Konflikten anzeigen",
			callback: () => this.showConflicts(),
		});

		// QR code / link from another device: obsidian://gdrive-vault-sync?code=ODS1:…
		// Such a link can be opened by any website or app. It is therefore only
		// accepted while this device is not connected, and never without asking.
		this.registerObsidianProtocolHandler(LINK_ACTION, (params) => {
			if (!params.code) return;
			if (this.isConnected()) {
				new Notice(
					"Google Drive Sync: Dieses Gerät ist bereits verbunden. Der Link wurde ignoriert. " +
						"Zum Wechseln zuerst in den Einstellungen „Verbindung trennen“ wählen.",
					10000
				);
				return;
			}
			void this.connectWithCode(params.code);
		});

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.statusEl.onClickEvent(() => this.sync(true));
		this.registerInterval(window.setInterval(() => this.renderStatus(), 30_000));
		this.renderStatus();

		this.addSettingTab(new DriveSyncSettingTab(this.app, this));

		// Sync shortly after edits stop (keeps devices close together -> fewer conflicts).
		const afterEdit = debounce(() => this.sync(false), 10_000, true);
		const onChange = (f: TAbstractFile) => {
			if (!this.settings.syncAfterEdit || this.syncing) return;
			if (f.path.startsWith(this.app.vault.configDir + "/")) return;
			if (this.isLogFile(f.path)) return; // our own log writes must not trigger a sync
			afterEdit();
		};
		this.app.workspace.onLayoutReady(() => {
			this.registerEvent(this.app.vault.on("modify", onChange));
			this.registerEvent(this.app.vault.on("create", onChange));
			this.registerEvent(this.app.vault.on("delete", onChange));
			this.registerEvent(this.app.vault.on("rename", onChange));
			if (this.settings.syncOnStartup) window.setTimeout(() => this.sync(false), 1500);
		});

		// Connection lost / back: show it at once, and catch up as soon as the device is online again.
		let reconnect: number | null = null;
		this.registerDomEvent(window, "offline", () => {
			this.offline = true;
			this.renderStatus();
		});
		this.registerDomEvent(window, "online", () => {
			if (reconnect !== null) window.clearTimeout(reconnect);
			// Wait a moment: right after "online" the connection is often not usable yet.
			reconnect = window.setTimeout(() => {
				reconnect = null;
				if (this.offline || this.lastError) void this.sync(false);
			}, 3000);
		});
		this.register(() => {
			if (reconnect !== null) window.clearTimeout(reconnect);
		});

		// Phones/tablets: sync when the app comes back to the foreground.
		this.registerDomEvent(document, "visibilitychange", () => {
			if (document.visibilityState === "visible" && this.settings.syncOnResume) {
				if (Date.now() - this.lastSync > 20_000) this.sync(false);
			}
		});

		this.restartInterval();
	}

	restartInterval() {
		if (this.intervalId !== null) window.clearInterval(this.intervalId);
		this.intervalId = null;
		const minutes = this.settings.autoSyncMinutes;
		if (minutes > 0) {
			this.intervalId = window.setInterval(() => this.sync(false), minutes * 60_000);
			this.registerInterval(this.intervalId);
		}
	}

	isConnected() {
		return !!(this.settings.clientId && this.settings.refreshToken);
	}

	async sync(manual: boolean) {
		if (!this.isConnected()) {
			if (manual) new Notice("Google Drive Sync: Bitte zuerst in den Einstellungen verbinden.");
			return;
		}
		if (this.syncing) {
			this.pending = true;
			return;
		}
		// Known to be offline: automatic syncs do not even try (saves battery, no error).
		// Local changes are not lost – the next sync finds them by their checksums.
		if (!manual && typeof navigator !== "undefined" && navigator.onLine === false) {
			this.offline = true;
			this.renderStatus();
			return;
		}
		// A stopped sync waits for the user; a manual sync checks again from scratch.
		if ((this.massDelete || this.authBroken) && !manual) return;
		this.authBroken = false;
		this.massDelete = null;
		const allowMassDelete = this.massDeleteConfirmed;
		this.massDeleteConfirmed = false;
		this.syncing = true;
		this.offline = false;
		const progress = manual ? new Notice("Synchronisiere …", 0) : null;
		const start = new Date();
		try {
			const result = await this.engine.run((msg) => {
				this.statusEl.setText(`☁ ${msg}`);
				progress?.setMessage(msg);
			}, allowMassDelete, manual);
			this.lastSync = Date.now();
			this.lastError = result.errors[0] ?? "";
			if (!this.lastError) this.lastReported = "";
			this.report(result, manual);
			await this.writeLog(start, result, null);
		} catch (e) {
			this.lastError = (e as Error).message;
			if (e instanceof MassDeleteError) {
				this.massDelete = e;
				if (manual) {
					progress?.hide();
					void confirmMassDelete(this.app, e).then((yes) => {
						if (!yes) return;
						this.massDeleteConfirmed = true;
						void this.sync(true);
					});
				} else {
					new Notice(
						`Google Drive Sync: ${this.lastError} Zum Prüfen auf das Wolken-Symbol in der Statusleiste klicken.`,
						0
					);
				}
			} else if (e instanceof DriveError && e.network && !manual) {
				// No connection or a connection too slow during an automatic sync is
				// normal (plane, train): no message and no log entry, the next attempt
				// follows by itself – at the latest when the device is online again.
				this.offline = true;
				return;
			} else {
				if (e instanceof DriveError && (e.kind === "auth" || e.kind === "blocked")) this.authBroken = true;
				// A lasting problem (Google down, rate limit …) is reported once, not on every attempt.
				if (!manual && this.lastError === this.lastReported) return;
				this.lastReported = this.lastError;
				new Notice(`Google Drive Sync: ${this.lastError}`, this.authBroken ? 0 : 8000);
			}
			await this.writeLog(start, null, this.lastError);
		} finally {
			progress?.hide();
			this.syncing = false;
			this.renderStatus();
			if (this.pending) {
				this.pending = false;
				window.setTimeout(() => this.sync(false), 1000);
			}
		}
	}

	isLogFile(path: string): boolean {
		return this.settings.logEnabled && makeLogMatcher(this.settings.logFolder)(path);
	}

	ownLogPath(): string {
		return logPath(this.settings.logFolder, this.settings.deviceName);
	}

	/** Writes one entry to "Sync-Protokoll/<Gerät>.md" (only this device writes that file). */
	private async writeLog(start: Date, result: SyncResult | null, fatal: string | null) {
		if (!this.settings.logEnabled) return;
		try {
			const entry = formatEntry(start, Date.now() - start.getTime(), result, fatal, (p) => this.isLogFile(p));
			if (!entry) return;
			const path = this.ownLogPath();
			const vault = this.app.vault;
			const existing = vault.getAbstractFileByPath(path);
			if (existing instanceof TFile) {
				await vault.process(existing, (old) => addEntry(old, entry, this.settings.deviceName));
				return;
			}
			const folder = this.settings.logFolder.replace(/^\/+|\/+$/g, "");
			if (!vault.getAbstractFileByPath(folder)) await vault.createFolder(folder).catch(() => undefined);
			await vault.create(path, addEntry("", entry, this.settings.deviceName));
		} catch (e) {
			console.error("[Google Drive Sync] Protokoll konnte nicht geschrieben werden", e);
		}
	}

	async openLog() {
		const f = this.app.vault.getAbstractFileByPath(this.ownLogPath());
		if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
		else new Notice("Noch kein Protokoll vorhanden – es entsteht bei der ersten Übertragung.");
	}

	private report(r: SyncResult, manual: boolean) {
		// Transfers of the log files themselves are not worth a notice.
		const ev = r.events.filter((e) => !this.isLogFile(e.path));
		const n = (...kinds: string[]) => ev.filter((e) => kinds.includes(e.kind)).length;
		const parts: string[] = [];
		if (n("up")) parts.push(`↑ ${n("up")}`);
		if (n("down")) parts.push(`↓ ${n("down")}`);
		if (n("delLocal", "delRemote")) parts.push(`🗑 ${n("delLocal", "delRemote")}`);
		if (n("merged")) parts.push(`${n("merged")} zusammengeführt`);
		if (r.marked.length) {
			const n = new Notice(
				`Google Drive Sync: In ${r.marked.length} Notiz(en) wurde dieselbe Stelle auf zwei Geräten geändert. ` +
					`Beide Versionen sind in der Notiz markiert (⚠ Sync-Konflikt):\n` +
					r.marked.join("\n") +
					"\n\nKlicken zum Öffnen.",
				20000
			);
			n.noticeEl.addEventListener("click", () => this.openNote(r.marked[0]));
		}
		if (r.conflicts.length) {
			new Notice(
				`Google Drive Sync: ${r.conflicts.length} Konflikt(e). Die ältere Version der Datei wurde gespeichert als:\n` +
					r.conflicts.join("\n"),
				15000
			);
		}
		if (r.errors.length) {
			console.error("[Google Drive Sync]", r.errors);
			new Notice(`Google Drive Sync: ${r.errors.length} Fehler – ${r.errors[0]}`, 10000);
		}
		if (r.configChanged) {
			const n = new Notice(
				"Google Drive Sync: Einstellungen von einem anderen Gerät wurden übernommen. " +
					"Damit sie wirksam werden, Obsidian neu laden – hier tippen.",
				0
			);
			n.noticeEl.addEventListener("click", () => {
				// eslint-disable-next-line @typescript-eslint/no-explicit-any
				(this.app as any).commands?.executeCommandById("app:reload");
			});
		}
		if (manual || (this.settings.showNotices && parts.length)) {
			new Notice(`Google Drive Sync: ${parts.length ? parts.join(" · ") : "Alles aktuell ✓"}`);
		}
	}

	connectionCode(): string {
		return exportConnection({
			clientId: this.settings.clientId,
			clientSecret: this.settings.clientSecret,
			refreshToken: this.settings.refreshToken,
		});
	}

	/**
	 * Takes over a connection code (pasted, or from a scanned QR code / tapped link).
	 * Always shows which Google account it belongs to and asks for confirmation,
	 * so a foreign link can never silently connect this vault to someone else's Drive.
	 */
	async connectWithCode(code: string, onDone?: () => void) {
		let creds: Credentials;
		try {
			creds = importConnection(code);
		} catch (e) {
			new Notice((e as Error).message);
			return;
		}
		if (creds.refreshToken === this.settings.refreshToken) {
			new Notice("Dieses Gerät ist bereits mit diesem Code verbunden ✓");
			return;
		}
		let email = "";
		try {
			email = await new DriveClient(() => creds).accountEmail();
		} catch (e) {
			new Notice(`Der Verbindungscode funktioniert nicht: ${(e as Error).message}`, 10000);
			return;
		}
		new ConfirmConnectModal(this.app, email, this.isConnected(), async () => {
			Object.assign(this.settings, creds);
			this.massDelete = null;
			await this.saveAll();
			new Notice(`Mit Google Drive verbunden ✓ (${email})`);
			this.renderStatus();
			onDone?.();
			void this.sync(true);
		}).open();
	}

	async openNote(path: string) {
		const f = this.app.vault.getAbstractFileByPath(path);
		if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
	}

	async showBackups(onlyPath?: string) {
		let list = await this.engine.backups.list();
		if (onlyPath) list = list.filter((b) => b.original === onlyPath);
		if (!list.length) {
			new Notice(onlyPath ? "Für diese Datei gibt es keine Sicherung." : "Es gibt noch keine Sicherungen.");
			return;
		}
		new BackupListModal(this.app, list, async (b) => {
			if (this.syncing) {
				new Notice("Bitte warten, bis die Synchronisierung fertig ist.");
				return;
			}
			try {
				this.syncing = true;
				await this.engine.restore(b.backupPath, b.original);
				new Notice(`Wiederhergestellt: ${b.original} (Stand ${formatDateTime(new Date(b.time))}). Die ersetzte Version wurde ebenfalls gesichert.`);
				if (b.original.startsWith(this.app.vault.configDir + "/")) {
					new Notice("Einstellungen wiederhergestellt – Obsidian neu laden, damit sie wirken.", 10000);
				}
			} catch (e) {
				new Notice(`Wiederherstellen fehlgeschlagen: ${(e as Error).message}`, 10000);
			} finally {
				this.syncing = false;
			}
			void this.sync(false);
		}).open();
	}

	failureCount(): number {
		return Object.keys(this.state.failures ?? {}).length;
	}

	showFailures() {
		const entries = Object.entries(this.state.failures ?? {});
		if (!entries.length) {
			new Notice("Keine zurückgestellten Dateien ✓");
			return;
		}
		new FailureListModal(this.app, entries, async (path) => {
			const f = this.app.vault.getAbstractFileByPath(path);
			if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f);
		}, () => this.sync(true)).open();
	}

	async showConflicts() {
		const files: TFile[] = [];
		for (const f of this.app.vault.getMarkdownFiles()) {
			if (hasConflictMarkers(await this.app.vault.cachedRead(f))) files.push(f);
		}
		if (!files.length) {
			new Notice("Keine offenen Sync-Konflikte ✓");
			return;
		}
		new ConflictListModal(this.app, files, (f) => this.openNote(f.path)).open();
	}

	renderStatus() {
		if (!this.statusEl || this.syncing) return;
		if (!this.isConnected()) {
			this.statusEl.setText("☁ nicht verbunden");
			return;
		}
		if (this.massDelete) {
			this.statusEl.setText("☁ ⚠ Bestätigung nötig");
			this.statusEl.setAttr("aria-label", this.massDelete.message);
			return;
		}
		if (this.authBroken) {
			this.statusEl.setText("☁ ⚠ neu verbinden");
			this.statusEl.setAttr("aria-label", this.lastError);
			return;
		}
		if (this.offline) {
			this.statusEl.setText("☁ offline");
			this.statusEl.setAttr(
				"aria-label",
				`${this.lastError || "Keine Verbindung"} – Änderungen werden synchronisiert, sobald wieder eine Verbindung besteht.`
			);
			return;
		}
		if (this.lastError) {
			this.statusEl.setText("☁ ⚠ Fehler");
			this.statusEl.setAttr("aria-label", this.lastError);
			return;
		}
		if (!this.lastSync) {
			this.statusEl.setText("☁ bereit");
			return;
		}
		const min = Math.floor((Date.now() - this.lastSync) / 60_000);
		const failing = this.failureCount();
		this.statusEl.setText(
			(min < 1 ? "☁ ✓ gerade eben" : `☁ ✓ vor ${min} Min.`) + (failing ? ` · ⏸ ${failing}` : "")
		);
		this.statusEl.setAttr(
			"aria-label",
			(failing ? `${failing} Datei(en) nach Fehler zurückgestellt – Befehl „Dateien mit Sync-Fehlern anzeigen“ · ` : "") +
				`Klicken zum Synchronisieren (versucht auch zurückgestellte Dateien) · ${this.manifest.name} ${this.manifest.version}`
		);
	}

	async loadAll() {
		let data: Partial<PluginData> = {};
		try {
			const raw = (await this.loadData()) as unknown;
			if (raw && typeof raw === "object" && !Array.isArray(raw)) data = raw as Partial<PluginData>;
		} catch (e) {
			// data.json is damaged (e.g. the device was switched off while writing).
			// Keep a copy and start with default settings instead of not loading at all.
			await this.rescueBrokenData(e);
		}
		if (!isRecord(data.settings)) data.settings = undefined;
		if (!isRecord(data.state)) data.state = undefined;
		const defaults: Settings = {
				clientId: "",
				clientSecret: "",
				refreshToken: "",
				folderName: `Obsidian – ${this.app.vault.getName()}`,
				deviceName: defaultDeviceName(),
				autoSyncMinutes: 2,
				syncOnStartup: true,
				syncAfterEdit: true,
				syncOnResume: true,
				excludes: ".trash/**\n# Eigene Ausschlüsse, z. B.:\n# Privat/**\n# *.mp4",
				showNotices: false,
				logEnabled: true,
				logFolder: "Sync-Protokoll",
				installId: "",
				backupEnabled: true,
				backupKeepDays: 30,
				backupMaxMB: 300,
				config: { enabled: false, settings: true, appearance: true, plugins: true },
		};
		this.settings = Object.assign({}, defaults, data.settings);
		// A value of the wrong type (damaged or hand-edited file) falls back to its default.
		for (const key of Object.keys(defaults) as (keyof Settings)[]) {
			if (typeof this.settings[key] !== typeof defaults[key]) (this.settings as any)[key] = defaults[key];
		}
		if (!isRecord(this.settings.config)) this.settings.config = defaults.config;
		if (!(this.settings.backupKeepDays >= 1 && this.settings.backupKeepDays <= 365)) this.settings.backupKeepDays = 30;
		if (!(this.settings.backupMaxMB >= 20 && this.settings.backupMaxMB <= 5000)) this.settings.backupMaxMB = 300;
		if (!(this.settings.autoSyncMinutes >= 0 && this.settings.autoSyncMinutes <= 30)) this.settings.autoSyncMinutes = 2;
		if (!isSafeSyncPath(this.settings.logFolder.replace(/^\/+|\/+$/g, ""), this.app.vault.configDir)) {
			this.settings.logFolder = defaults.logFolder;
		}
		if (!/^[a-z0-9]{6,32}$/.test(this.settings.installId)) this.settings.installId = newInstallId();
		this.secrets = new SecretStore(this.app, this.manifest.id, this.settings.installId);
		const inFile = !!(data.settings?.clientSecret || data.settings?.refreshToken);
		if (this.secrets.available) {
			// Values still in data.json (older version, or pasted there) win and
			// are moved to the keychain by the save below.
			this.settings.clientSecret ||= this.secrets.get("client-secret");
			this.settings.refreshToken ||= this.secrets.get("refresh-token");
		}
		this.settings.config = Object.assign({}, defaults.config, this.settings.config);
		for (const key of Object.keys(defaults.config) as (keyof ConfigSyncOptions)[]) {
			if (typeof this.settings.config[key] !== "boolean") this.settings.config[key] = defaults.config[key];
		}
		this.state = Object.assign({ base: {}, cache: {}, folderId: "", folderName: "" }, data.state);
		if (!isRecord(this.state.base)) this.state.base = {};
		if (!isRecord(this.state.cache)) this.state.cache = {};
		if (typeof this.state.folderId !== "string") this.state.folderId = "";
		if (typeof this.state.folderName !== "string") this.state.folderName = "";
		if (!isRecord(this.state.failures)) this.state.failures = {};
		if (inFile && this.secrets.available) await this.saveAll();
	}

	private async rescueBrokenData(error: unknown) {
		console.error("[Google Drive Sync] data.json ist beschädigt", error);
		const file = `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/data.json`;
		let kept = "";
		try {
			const copy = `${file}.defekt-${Date.now()}`;
			await this.app.vault.adapter.copy(file, copy);
			kept = ` Eine Kopie liegt unter ${copy}.`;
		} catch {
			/* nothing to keep */
		}
		new Notice(
			"Google Drive Sync: Die Einstellungsdatei des Plugins war beschädigt und wurde zurückgesetzt. " +
				"Bitte die Einstellungen prüfen und ggf. neu verbinden. Es gehen keine Notizen verloren." +
				kept,
			0
		);
	}

	/** True if the credentials are kept in Obsidian's keychain instead of data.json. */
	usesKeychain(): boolean {
		return this.secrets.available;
	}

	async saveAll() {
		const settings = { ...this.settings };
		// Only blank a value in data.json after the keychain has verifiably taken it.
		if (this.secrets.set("client-secret", settings.clientSecret)) settings.clientSecret = "";
		if (this.secrets.set("refresh-token", settings.refreshToken)) settings.refreshToken = "";
		await this.saveData({ settings, state: this.state } satisfies PluginData);
	}
}

const LINK_ACTION = "gdrive-vault-sync";

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

class QrModal extends Modal {
	constructor(app: App, private code: string) {
		super(app);
	}
	onOpen() {
		const { contentEl } = this;
		this.titleEl.setText("Weiteres Gerät verbinden");
		const link = `obsidian://${LINK_ACTION}?code=${encodeURIComponent(this.code)}`;
		const qr = qrcode(0, "L");
		qr.addData(link);
		qr.make();
		const svg = new DOMParser().parseFromString(
			qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true }),
			"image/svg+xml"
		).documentElement;
		svg.setAttribute("width", "100%");
		svg.removeAttribute("height");
		const box = contentEl.createDiv();
		box.setCssStyles({
			background: "#ffffff",
			padding: "12px",
			borderRadius: "8px",
			maxWidth: "340px",
			margin: "0 auto 12px",
		});
		box.appendChild(contentEl.doc.importNode(svg, true));

		const ol = contentEl.createEl("ol");
		ol.createEl("li", { text: "Auf dem Tablet/Handy Obsidian mit dem richtigen Vault öffnen – das Plugin muss dort installiert und aktiviert sein." });
		ol.createEl("li", { text: "Die Kamera-App öffnen und auf diesen QR-Code richten." });
		ol.createEl("li", { text: "Auf den eingeblendeten Hinweis „In Obsidian öffnen“ tippen und bestätigen." });
		contentEl.createEl("p", {
			cls: "mod-warning",
			text: "⚠ Der QR-Code enthält deinen Zugang. Keinen Screenshot teilen und das Fenster nach dem Scannen schließen.",
		});
	}
	onClose() {
		this.contentEl.empty();
	}
}

class ConfirmConnectModal extends Modal {
	constructor(
		app: App,
		private email: string,
		private replaces: boolean,
		private onConfirm: () => void | Promise<void>
	) {
		super(app);
	}
	onOpen() {
		this.titleEl.setText("Mit Google Drive verbinden?");
		if (this.replaces) {
			this.contentEl.createEl("p", {
				cls: "mod-warning",
				text: "⚠ Dieses Gerät ist bereits verbunden. Die bestehende Verbindung wird ersetzt.",
			});
		}
		this.contentEl.createEl("p", {
			text: `Dieses Gerät wird mit dem Google-Konto ${this.email || "(unbekannt)"} verbunden. Deine Notizen werden in dessen Google Drive synchronisiert.`,
		});
		this.contentEl.createEl("p", {
			cls: "setting-item-description",
			text: "Nur bestätigen, wenn das dein eigenes Konto ist und du den Code selbst erzeugt hast.",
		});
		new Setting(this.contentEl)
			.addButton((b) => {
				b.setButtonText("Abbrechen").onClick(() => this.close());
				// Enter must not confirm by accident.
				window.setTimeout(() => b.buttonEl.focus(), 0);
			})
			.addButton((b) =>
				b
					.setButtonText("Verbinden")
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.onConfirm();
					})
			);
	}
	onClose() {
		this.contentEl.empty();
	}
}

class BackupListModal extends FuzzySuggestModal<BackupEntry> {
	constructor(app: App, private entries: BackupEntry[], private choose: (b: BackupEntry) => void) {
		super(app);
		this.setPlaceholder(`${entries.length} Sicherung(en) – Datei oder Datum eingeben, auswählen zum Wiederherstellen`);
	}
	getItems() {
		return this.entries;
	}
	getItemText(b: BackupEntry) {
		const kb = b.size < 1024 ? `${b.size} B` : `${Math.round(b.size / 1024)} KB`;
		return `${b.original} — Stand vor ${formatDateTime(new Date(b.time))} (${kb})`;
	}
	onChooseItem(b: BackupEntry) {
		this.choose(b);
	}
}

class FailureListModal extends FuzzySuggestModal<[string, FailureEntry]> {
	constructor(
		app: App,
		private entries: [string, FailureEntry][],
		private open_: (path: string) => void,
		private retry: () => void
	) {
		super(app);
		this.setPlaceholder(
			`${entries.length} zurückgestellte Datei(en) – auswählen zum Öffnen. Manuell synchronisieren versucht alle erneut.`
		);
		this.setInstructions([
			{ command: "↵", purpose: "Datei öffnen" },
			{ command: "Statusleiste", purpose: "klicken = alle jetzt erneut versuchen" },
		]);
	}
	getItems() {
		return this.entries;
	}
	getItemText([path, f]: [string, FailureEntry]) {
		const next = new Date(f.nextTry);
		const pad = (n: number) => String(n).padStart(2, "0");
		const when = f.nextTry <= Date.now() ? "beim nächsten Lauf" : `ab ${pad(next.getHours())}:${pad(next.getMinutes())}`;
		return `${path}${f.folder ? "/" : ""} — ${f.error} (${f.count}×, nächster Versuch ${when})`;
	}
	onChooseItem([path]: [string, FailureEntry]) {
		this.open_(path);
	}
}

class ConflictListModal extends FuzzySuggestModal<TFile> {
	constructor(app: App, private files: TFile[], private choose: (f: TFile) => void) {
		super(app);
		this.setPlaceholder(`${files.length} Notiz(en) mit Sync-Konflikten – auswählen zum Öffnen`);
	}
	getItems() {
		return this.files;
	}
	getItemText(f: TFile) {
		return f.path;
	}
	onChooseItem(f: TFile) {
		this.choose(f);
	}
}

class DriveSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: DriveSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		const p = this.plugin;
		const s = p.settings;
		containerEl.empty();

		// Header with the installed version
		const releases = "https://github.com/4ndr345geo/claude-obsidian-sync/releases";
		new Setting(containerEl)
			.setName(p.manifest.name)
			.setDesc(`Installierte Version: ${p.manifest.version}`)
			.addExtraButton((b) =>
				b
					.setIcon("external-link")
					.setTooltip("Alle Versionen und Änderungen auf GitHub")
					.onClick(() => window.open(releases))
			);

		containerEl.createEl("h3", { text: "Verbindung" });
		const status = containerEl.createDiv({ cls: "setting-item-description" });
		status.setText(
			p.isConnected()
				? `✓ Verbunden. Ordner in Google Drive: „${s.folderName}“`
				: "Nicht verbunden. Anleitung: siehe README des Plugins."
		);
		containerEl.createDiv({
			cls: "setting-item-description",
			text: p.usesKeychain()
				? "Zugangsdaten: im Schlüsselbund von Obsidian gespeichert, nicht im Vault-Ordner."
				: `Zugangsdaten: unverschlüsselt in ${this.app.vault.configDir}/plugins/${p.manifest.id}/data.json ` +
					"(diese Obsidian-Version hat keinen Schlüsselbund – ab 1.11.4 werden sie dorthin verschoben).",
		});

		if (Platform.isDesktopApp) {
			new Setting(containerEl)
				.setName("OAuth Client-ID")
				.setDesc("Aus der Google Cloud Console (Typ „Desktop-App“).")
				.addText((t) =>
					t.setValue(s.clientId).onChange(async (v) => {
						s.clientId = v.trim();
						await p.saveAll();
					})
				);
			new Setting(containerEl).setName("OAuth Client-Secret").addText((t) => {
				t.inputEl.type = "password";
				t.setValue(s.clientSecret).onChange(async (v) => {
					s.clientSecret = v.trim();
					await p.saveAll();
				});
			});
			new Setting(containerEl)
				.setName(p.isConnected() ? "Neu verbinden" : "Mit Google Drive verbinden")
				.setDesc("Öffnet den Browser zur Google-Anmeldung.")
				.addButton((b) =>
					b
						.setButtonText("Verbinden")
						.setCta()
						.onClick(async () => {
							if (!s.clientId || !s.clientSecret) {
								new Notice("Bitte zuerst Client-ID und Client-Secret eintragen.");
								return;
							}
							try {
								s.refreshToken = await authorizeDesktop(s.clientId, s.clientSecret);
								await p.saveAll();
								new Notice("Mit Google Drive verbunden ✓");
								this.display();
								p.sync(true);
							} catch (e) {
								new Notice(`Verbindung fehlgeschlagen: ${(e as Error).message}`, 8000);
							}
						})
				);
		}

		if (p.isConnected()) {
			new Setting(containerEl)
				.setName("Weiteres Gerät verbinden")
				.setDesc(
					"QR-Code mit der Kamera von iPad/iPhone/Android scannen – oder den Code kopieren und dort einfügen. " +
						"Enthält deinen Zugang – nicht weitergeben!"
				)
				.addButton((b) =>
					b
						.setButtonText("QR-Code anzeigen")
						.setCta()
						.onClick(() => new QrModal(this.app, p.connectionCode()).open())
				)
				.addButton((b) =>
					b.setButtonText("Code kopieren").onClick(async () => {
						const copied = p.connectionCode();
						await navigator.clipboard.writeText(copied);
						new Notice("Verbindungscode kopiert. Die Zwischenablage wird nach 60 Sekunden geleert.");
						// Best effort: do not leave the access in the clipboard (history, cloud clipboard).
						window.setTimeout(async () => {
							try {
								if ((await navigator.clipboard.readText()) === copied) await navigator.clipboard.writeText("");
							} catch {
								/* clipboard not readable (e.g. app in background) */
							}
						}, 60_000);
					})
				);
		}

		let code = "";
		new Setting(containerEl)
			.setName("Verbindungscode einfügen")
			.setDesc(
				"Für Handy/Tablet. Einfacher: am Computer „QR-Code anzeigen“ wählen und mit der Kamera scannen."
			)
			.addText((t) => t.setPlaceholder("ODS1:…").onChange((v) => (code = v)))
			.addButton((b) =>
				b.setButtonText("Übernehmen").onClick(() => p.connectWithCode(code, () => this.display()))
			);

		if (p.isConnected()) {
			new Setting(containerEl).setName("Trennen").addButton((b) =>
				b
					.setButtonText("Verbindung trennen")
					.setWarning()
					.onClick(async () => {
						s.refreshToken = "";
						// On phones/tablets the secret only came from the connection code.
						if (!Platform.isDesktopApp) s.clientSecret = "";
						await p.saveAll();
						this.display();
						p.renderStatus();
					})
			);
		}

		containerEl.createEl("h3", { text: "Synchronisierung" });

		new Setting(containerEl)
			.setName("Ordnername in Google Drive")
			.setDesc("Muss auf allen Geräten gleich sein.")
			.addText((t) =>
				t.setValue(s.folderName).onChange(async (v) => {
					s.folderName = v.trim() || s.folderName;
					await p.saveAll();
				})
			);

		new Setting(containerEl)
			.setName("Gerätename")
			.setDesc("Erscheint im Namen von Konfliktkopien.")
			.addText((t) =>
				t.setValue(s.deviceName).onChange(async (v) => {
					s.deviceName = v.trim() || defaultDeviceName();
					await p.saveAll();
				})
			);

		new Setting(containerEl)
			.setName("Automatisch synchronisieren alle … Minuten")
			.setDesc("0 = aus")
			.addSlider((sl) =>
				sl
					.setLimits(0, 30, 1)
					.setValue(s.autoSyncMinutes)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.autoSyncMinutes = v;
						await p.saveAll();
						p.restartInterval();
					})
			);

		const toggle = (name: string, desc: string, key: "syncOnStartup" | "syncAfterEdit" | "syncOnResume" | "showNotices") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(s[key]).onChange(async (v) => {
						s[key] = v;
						await p.saveAll();
					})
				);
		toggle("Beim Start synchronisieren", "Empfohlen.", "syncOnStartup");
		toggle("Nach dem Bearbeiten synchronisieren", "10 Sekunden nach der letzten Änderung. Empfohlen.", "syncAfterEdit");
		toggle("Beim Zurückkehren in die App synchronisieren", "Wichtig für Handy und Tablet.", "syncOnResume");
		toggle("Meldung bei jeder Synchronisierung", "Zeigt eine Meldung, wenn Dateien übertragen wurden.", "showNotices");

		containerEl.createEl("h3", { text: "Einstellungen (.obsidian) synchronisieren" });
		const cfg = s.config;
		const cfgToggle = (name: string, desc: string, key: keyof ConfigSyncOptions, refresh = false) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addToggle((t) =>
					t.setValue(cfg[key]).onChange(async (v) => {
						cfg[key] = v;
						await p.saveAll();
						if (refresh) this.display();
					})
				);
		cfgToggle(
			"Einstellungen synchronisieren",
			"Überträgt Obsidian-Einstellungen, Themes und Plugins auf alle Geräte. Auf jedem Gerät einschalten, " +
				"zuerst auf dem Gerät mit den besten Einstellungen. Fensterlayout und der Zugang dieses Plugins bleiben " +
				"immer gerätespezifisch.",
			"enabled",
			true
		);
		if (cfg.enabled) {
			cfgToggle("Allgemeine Einstellungen", "Editor, Dateien & Links, Tastenkürzel, Kern-Plugins, Lesezeichen …", "settings");
			cfgToggle("Darstellung", "Themes und CSS-Snippets", "appearance");
			cfgToggle("Community-Plugins", "Installierte Plugins, ob sie aktiv sind, und ihre Einstellungen", "plugins");
		}

		containerEl.createEl("h3", { text: "Protokoll" });
		new Setting(containerEl)
			.setName("Sync-Protokoll schreiben")
			.setDesc(
				`Jedes Gerät schreibt in eine eigene Notiz („${s.logFolder}/${s.deviceName}.md“). So kannst du z. B. am ` +
					"Computer nachlesen, was auf dem iPad passiert ist. Einträge nur bei Übertragungen und Fehlern."
			)
			.addToggle((t) =>
				t.setValue(s.logEnabled).onChange(async (v) => {
					s.logEnabled = v;
					await p.saveAll();
					this.display();
				})
			)
			.addButton((b) => b.setButtonText("Öffnen").onClick(() => p.openLog()));
		if (s.logEnabled) {
			new Setting(containerEl)
				.setName("Ordner für Protokolle")
				.setDesc("Auf allen Geräten gleich lassen.")
				.addText((t) =>
					t.setValue(s.logFolder).onChange(async (v) => {
						const folder = v.trim().replace(/^\/+|\/+$/g, "");
						s.logFolder = isSafeSyncPath(folder, this.app.vault.configDir) ? folder : "Sync-Protokoll";
						await p.saveAll();
					})
				);
		}

		containerEl.createEl("h3", { text: "Sicherungen" });
		new Setting(containerEl)
			.setName("Lokale Sicherung vor dem Überschreiben")
			.setDesc(
				"Bevor die Synchronisierung eine Datei auf diesem Gerät überschreibt oder löscht, wird die bisherige Version " +
					`in ${this.app.vault.configDir}/plugins/${p.manifest.id}/backups gesichert (nur auf diesem Gerät). ` +
					"Zurückholen: Befehl „Frühere Version aus lokaler Sicherung wiederherstellen“."
			)
			.addToggle((t) =>
				t.setValue(s.backupEnabled).onChange(async (v) => {
					s.backupEnabled = v;
					await p.saveAll();
					this.display();
				})
			)
			.addButton((b) => b.setButtonText("Anzeigen").onClick(() => p.showBackups()));
		if (s.backupEnabled) {
			new Setting(containerEl)
				.setName("Sicherungen aufbewahren (Tage)")
				.addSlider((sl) =>
					sl
						.setLimits(1, 90, 1)
						.setValue(s.backupKeepDays)
						.setDynamicTooltip()
						.onChange(async (v) => {
							s.backupKeepDays = v;
							await p.saveAll();
						})
				);
			new Setting(containerEl)
				.setName("Höchstens belegter Speicher (MB)")
				.setDesc("Darüber werden die ältesten Sicherungen entfernt. Einzelne Dateien über einem Viertel davon (max. 50 MB) werden nicht gesichert.")
				.addSlider((sl) =>
					sl
						.setLimits(50, 2000, 50)
						.setValue(s.backupMaxMB)
						.setDynamicTooltip()
						.onChange(async (v) => {
							s.backupMaxMB = v;
							await p.saveAll();
						})
				);
		}

		containerEl.createEl("h3", { text: "Erweitert" });
		new Setting(containerEl)
			.setName("Ausschließen")
			.setDesc(
				"Ein Muster pro Zeile, z. B. „Privat/**“, „*.mp4“ oder für ein einzelnes Plugin " +
					"„.obsidian/plugins/obsidian-git/**“."
			)
			.addTextArea((t) => {
				t.inputEl.rows = 5;
				t.setValue(s.excludes).onChange(async (v) => {
					s.excludes = v;
					await p.saveAll();
				});
			});
	}
}

function confirmMassDelete(app: App, e: MassDeleteError): Promise<boolean> {
	return new Promise((resolve) => {
		let answer = false;
		const m = new Modal(app);
		m.titleEl.setText("Viele Dateien löschen?");
		m.contentEl.createEl("p", { text: e.message });
		m.contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Das passiert z. B., wenn der Ordner in Google Drive geleert oder ersetzt wurde oder der Vault auf diesem " +
				"Gerät nicht vollständig geladen ist. Nur fortfahren, wenn du die Dateien wirklich gelöscht hast. " +
				"Im Zweifel abbrechen und den Ordner in Google Drive (auch den Papierkorb) prüfen.",
		});
		new Setting(m.contentEl)
			.addButton((b) => {
				b.setButtonText("Abbrechen").onClick(() => m.close());
				window.setTimeout(() => b.buttonEl.focus(), 0);
			})
			.addButton((b) =>
				b
					.setButtonText(`${e.local + e.remote} Dateien löschen`)
					.setWarning()
					.onClick(() => {
						answer = true;
						m.close();
					})
			);
		m.onClose = () => resolve(answer);
		m.open();
	});
}
