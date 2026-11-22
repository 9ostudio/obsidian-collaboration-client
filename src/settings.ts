import { App, PluginSettingTab, type Setting, type SettingDefinitionItem } from 'obsidian'
import type CollaborationPlugin from './main'
import type { ShareRecord } from './main'

const SERVER_DESC = 'Set automatically by setup and invite links.'
const EMPTY_DESC = 'None yet. Right-click a folder to share it, or open an invite link.'

export class CollaborationSettingTab extends PluginSettingTab {
  constructor (app: App, private readonly plugin: CollaborationPlugin) {
    super(app, plugin)
  }

  private status (record: ShareRecord): string {
    const a = this.plugin.active.get(record.id)
    const state = !a ? 'paused' : a.session.connected && a.session.synced ? 'online' : 'offline'
    const perms = !a ? '' : a.session.isOwner ? 'owner' : [a.session.canWrite ? 'can edit' : 'read only', a.session.canDelete ? 'can delete' : ''].filter(Boolean).join(', ')
    return [perms, state].filter(Boolean).join(' · ')
  }

  private serverField (setting: Setting): void {
    setting.addText((t) => {
      t.setPlaceholder('https://…').setValue(this.plugin.server)
      t.inputEl.addEventListener('change', () => { void this.plugin.setServer(t.getValue()).then(() => this.update()) })
    })
  }

  private checkButton (setting: Setting): void {
    setting.addButton((b) => b.setButtonText('Check access now').onClick(() => { void this.plugin.checkAccess(true) }))
  }

  getSettingDefinitions (): SettingDefinitionItem[] {
    const records = Object.values(this.plugin.shares)
    return [
      { name: 'Server', desc: SERVER_DESC, aliases: ['address', 'url'], render: (setting) => this.serverField(setting) },
      {
        type: 'group',
        heading: 'Shared folders',
        items: records.length === 0
          ? [{ name: 'No shared folders', desc: EMPTY_DESC }]
          : records.map((record) => ({ name: record.path, desc: this.status(record) }))
      },
      { name: 'Check access', desc: 'Ask the server which shared folders you can still open.', render: (setting) => this.checkButton(setting) }
    ]
  }
}
