import { ItemView, WorkspaceLeaf, Notice, TFile } from "obsidian";
import type DriveSyncPlugin from "./main";
import { hasConflictMarkers } from "./merge";

export const VIEW_TYPE_GDRIVE_SYNC = "gdrive-sync-dashboard-view";

export class GDriveSyncDashboardView extends ItemView {
	private plugin: DriveSyncPlugin;
	private refreshTimer: number | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: DriveSyncPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_GDRIVE_SYNC;
	}

	getDisplayText(): string {
		return "Sync-Zentrale & Geräte";
	}

	getIcon(): string {
		return "hard-drive";
	}

	async onOpen() {
		await this.render();
		// Auto refresh view every 15 seconds while open
		this.refreshTimer = window.setInterval(() => {
			void this.render();
		}, 15_000);
	}

	async onClose() {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async render() {
		const container = this.containerEl.children[1] as HTMLElement;
		if (!container) return;
		container.empty();
		container.addClass("gdrive-sync-dashboard-root");

		const isConnected = this.plugin.isConnected();
		const s = this.plugin.settings;
		const logFolder = s.folderName ? s.logFolder : "Sync-Protokoll";
		const currentDevice = s.deviceName || "Dieses Gerät";

		// 1. Dashboard Header
		const headerEl = container.createDiv({ cls: "gdrive-dash-header" });
		const titleRow = headerEl.createDiv({ cls: "gdrive-dash-title-row" });
		
		const titleEl = titleRow.createEl("h2", { cls: "gdrive-dash-title", text: "Google Drive Sync-Zentrale" });
		const statusPill = titleRow.createSpan({
			cls: `gdrive-dash-badge ${isConnected ? "is-connected" : "is-disconnected"}`,
			text: isConnected ? "● Verbunden & Aktiv" : "○ Nicht verbunden",
		});

		const metaRow = headerEl.createDiv({ cls: "gdrive-dash-meta" });
		metaRow.createSpan({ text: `Google Drive Ordner: ${s.folderName || "Nicht gesetzt"}` });
		metaRow.createSpan({ text: "·" });
		metaRow.createSpan({ text: `Dieses Gerät: ${currentDevice}` });
		metaRow.createSpan({ text: "·" });
		metaRow.createSpan({ text: "Verschlüsselung: OAuth PKCE" });

		// 2. Primary Action Bar
		const actionsBar = container.createDiv({ cls: "gdrive-dash-actions-bar" });

		const syncBtn = actionsBar.createEl("button", {
			cls: "mod-cta gdrive-dash-btn",
			text: "⟳ Jetzt synchronisieren",
		});
		syncBtn.onclick = async () => {
			syncBtn.addClass("is-loading");
			syncBtn.setText("Synchronisiere...");
			try {
				await this.plugin.sync(true);
				new Notice("Synchronisierung erfolgreich abgeschlossen ✓");
			} catch (e: any) {
				new Notice(`Sync-Fehler: ${e.message}`);
			} finally {
				syncBtn.removeClass("is-loading");
				syncBtn.setText("⟳ Jetzt synchronisieren");
				await this.render();
			}
		};

		if (isConnected) {
			const qrBtn = actionsBar.createEl("button", {
				cls: "gdrive-dash-btn",
				text: "📲 Weiteres Gerät koppeln (QR)",
			});
			qrBtn.onclick = () => {
				this.plugin.showQrModal();
			};

			const disconnectAllBtn = actionsBar.createEl("button", {
				cls: "mod-warning gdrive-dash-btn is-danger",
				text: "🚫 Alle Geräte abmelden",
			});
			disconnectAllBtn.onclick = async () => {
				const confirmed = confirm(
					"Möchtest du wirklich alle Geräte abmelden?\n\n" +
					"Das Google Drive OAuth-Token wird widerrufen. Alle verbundenen Geräte (Computer, Handy, Tablet) werden sofort abgemeldet.\n\n" +
					"Deine Notizen im lokalen Vault und in Google Drive bleiben unberührt."
				);
				if (confirmed) {
					await this.plugin.disconnectAllDevices();
					await this.render();
				}
			};
		}

		// 3. Graphical SVG Topology Mesh Diagram
		const graphSection = container.createDiv({ cls: "gdrive-dash-graph-section" });
		graphSection.createEl("h3", { cls: "gdrive-dash-section-title", text: "Netzwerk-Topologie & Geräte-Verbindungen" });

		// Collect other known devices from log folder
		const files = this.app.vault.getFiles();
		const logFiles = files.filter(
			(f) => f.path.startsWith(logFolder + "/") && f.extension === "md"
		);

		const remoteDevices: Array<{ name: string; mtime: number; path: string }> = [];
		for (const f of logFiles) {
			const name = f.basename;
			if (name === currentDevice) continue;
			remoteDevices.push({
				name,
				mtime: f.stat.mtime,
				path: f.path,
			});
		}

		// Render interactive SVG Topology
		const svgContainer = graphSection.createDiv({ cls: "gdrive-dash-svg-wrapper" });
		svgContainer.innerHTML = this.generateTopologySvg(currentDevice, remoteDevices, isConnected);

		// 4. Device Cards Grid
		const devicesSection = container.createDiv({ cls: "gdrive-dash-devices-section" });
		devicesSection.createEl("h3", {
			cls: "gdrive-dash-section-title",
			text: `Synchronisierende Geräte (${1 + remoteDevices.length})`,
		});

		const cardsGrid = devicesSection.createDiv({ cls: "gdrive-dash-cards-grid" });

		// Local Device Card
		const localCard = cardsGrid.createDiv({ cls: "gdrive-device-card is-primary" });
		const localHead = localCard.createDiv({ cls: "gdrive-card-header" });
		localHead.createEl("span", { cls: "gdrive-card-icon", text: "💻" });
		const localTitles = localHead.createDiv({ cls: "gdrive-card-titles" });
		localTitles.createEl("strong", { text: currentDevice });
		localTitles.createEl("span", { cls: "gdrive-card-sub", text: "Dieses Gerät · Hauptarbeitsplatz" });
		localCard.createDiv({
			cls: "gdrive-card-status",
			text: isConnected ? "● Aktiv synchronisiert" : "○ Offline / Nicht verbunden",
		});
		
		const localFoot = localCard.createDiv({ cls: "gdrive-card-foot" });
		const localLogLink = localFoot.createEl("a", {
			cls: "gdrive-card-link",
			text: "Sync-Protokoll öffnen →",
		});
		localLogLink.onclick = async () => {
			const path = `${logFolder}/${currentDevice}.md`;
			await this.plugin.openNote(path);
		};

		// Remote Device Cards
		if (remoteDevices.length > 0) {
			for (const rd of remoteDevices) {
				const remoteCard = cardsGrid.createDiv({ cls: "gdrive-device-card" });
				const rHead = remoteCard.createDiv({ cls: "gdrive-card-header" });
				rHead.createEl("span", { cls: "gdrive-card-icon", text: "📱" });
				const rTitles = rHead.createDiv({ cls: "gdrive-card-titles" });
				rTitles.createEl("strong", { text: rd.name });
				rTitles.createEl("span", {
					cls: "gdrive-card-sub",
					text: `Letzter Sync: ${new Date(rd.mtime).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
				});

				remoteCard.createDiv({
					cls: "gdrive-card-status",
					text: "● Verbunden über Google Drive",
				});

				const rFoot = remoteCard.createDiv({ cls: "gdrive-card-foot" });
				const rLink = rFoot.createEl("a", {
					cls: "gdrive-card-link",
					text: "Geräte-Log öffnen →",
				});
				rLink.onclick = async () => {
					await this.plugin.openNote(rd.path);
				};
			}
		} else {
			// Demo hint for single device
			const hintCard = cardsGrid.createDiv({ cls: "gdrive-device-card is-hint" });
			hintCard.createEl("strong", { text: "Kein weiteres Gerät gekoppelt" });
			hintCard.createEl("p", {
				text: "Klicke oben auf „Weiteres Gerät koppeln (QR)“, um dein Handy oder Tablet mit der Kamera einzubinden.",
				cls: "setting-item-description",
			});
		}

		// 5. Conflict Monitor Section
		const conflictSection = container.createDiv({ cls: "gdrive-dash-conflicts-section" });
		const conflictFiles: TFile[] = [];
		for (const f of files.filter((f) => f.extension === "md")) {
			const content = await this.app.vault.read(f);
			if (hasConflictMarkers(content)) conflictFiles.push(f);
		}

		conflictSection.createEl("h3", { cls: "gdrive-dash-section-title", text: "Sync-Konflikt-Wächter" });
		if (conflictFiles.length > 0) {
			const alertBox = conflictSection.createDiv({ cls: "gdrive-conflict-alert" });
			alertBox.createEl("strong", {
				text: `⚠ ${conflictFiles.length} Notiz(en) mit Sync-Konflikten gefunden:`,
			});
			const conflictList = alertBox.createEl("ul");
			for (const cf of conflictFiles) {
				const item = conflictList.createEl("li");
				const a = item.createEl("a", { text: cf.path });
				a.onclick = async () => {
					await this.app.workspace.getLeaf(false).openFile(cf);
				};
			}
		} else {
			const okBox = conflictSection.createDiv({ cls: "gdrive-conflict-ok" });
			okBox.createEl("span", { text: "✓ Alle Notizen im Vault sind vollständig synchronisiert (0 Konflikte)." });
		}
	}

	private escapeHtml(str: string): string {
		return str
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");
	}

	private generateTopologySvg(
		currentDevice: string,
		remoteDevices: Array<{ name: string; mtime: number }>,
		isConnected: boolean
	): string {
		// Default demo satellite devices if only local device exists
		const satellites =
			remoteDevices.length > 0
				? remoteDevices.map((d) => ({
						name: d.name,
						isLocal: false,
				  }))
				: [
						{ name: "iPhone (Muster)", isLocal: false },
						{ name: "iPad (Muster)", isLocal: false },
				  ];

		const width = 560;
		const height = Math.max(240, satellites.length * 76 + 44);
		const cx = width / 2;
		const cy = height / 2 - 10;

		const stepY = satellites.length > 1 ? (height - 90) / (satellites.length - 1) : 0;
		const startY = satellites.length > 1 ? 45 : cy;

		// Include local device in mesh
		const allNodes = [
			{ name: currentDevice, isLocal: true, x: cx - 180, y: cy },
			...satellites.map((s, idx) => ({
				name: s.name,
				isLocal: false,
				x: cx + 180,
				y: startY + idx * stepY,
			})),
		];

		const activeColor = isConnected ? "#10b981" : "#ef4444";
		const hubBg = isConnected ? "#8b5cf6" : "#64748b";

		let linesSvg = "";
		let nodesSvg = "";

		for (const node of allNodes) {
			linesSvg += `
				<path d="M ${node.x} ${node.y} Q ${cx} ${cy + 10} ${cx} ${cy}" 
					fill="none" 
					stroke="${activeColor}" 
					stroke-width="2" 
					stroke-dasharray="5 4" 
					opacity="0.8" 
					class="gdrive-svg-line" />
			`;

			nodesSvg += `
				<g transform="translate(${node.x}, ${node.y})" class="gdrive-svg-node">
					<circle r="22" fill="#1e2230" stroke="${node.isLocal ? "#a855f7" : "#475569"}" stroke-width="2" />
					<text y="5" text-anchor="middle" font-size="14" fill="#ffffff">${node.isLocal ? "💻" : "📱"}</text>
					<text y="38" text-anchor="middle" font-size="11" font-weight="600" fill="#cbd5e1">${this.escapeHtml(node.name)}</text>
				</g>
			`;
		}

		return `
			<svg viewBox="0 0 ${width} ${height}" class="gdrive-topology-svg" xmlns="http://www.w3.org/2000/svg">
				<defs>
					<radialGradient id="hubGlow" cx="50%" cy="50%" r="50%">
						<stop offset="0%" stop-color="${hubBg}" stop-opacity="0.4"/>
						<stop offset="100%" stop-color="${hubBg}" stop-opacity="0"/>
					</radialGradient>
				</defs>
				
				<!-- Background glow -->
				<circle cx="${cx}" cy="${cy}" r="70" fill="url(#hubGlow)" />
				
				<!-- Connection Lines -->
				${linesSvg}

				<!-- Central Google Drive Hub -->
				<g transform="translate(${cx}, ${cy})">
					<circle r="32" fill="#181b26" stroke="${activeColor}" stroke-width="2.5" />
					<circle r="38" fill="none" stroke="${activeColor}" stroke-width="1" stroke-dasharray="4 4" opacity="0.6" class="gdrive-pulse-ring" />
					<text y="7" text-anchor="middle" font-size="20">☁️</text>
					<text y="52" text-anchor="middle" font-size="12" font-weight="700" fill="#ffffff">Google Drive Vault</text>
					<text y="66" text-anchor="middle" font-size="10" fill="#94a3b8">drive.file</text>
				</g>

				<!-- Device Nodes -->
				${nodesSvg}
			</svg>
		`;
	}
}
