import { useAppBackground, getAppBackgroundActions } from '../../../application/state/appBackgroundStore';
import { useI18n } from '../../../application/i18n/I18nProvider';
import { Button } from '../../ui/button';
import { SectionHeader, SettingCard, SettingRow, Toggle } from '../settings-ui';

export function AppBackgroundSettingsCard() {
  const { t } = useI18n();
  const { settings, imageUrl, busy, error } = useAppBackground();
  const actions = getAppBackgroundActions();
  return <section>
    <SectionHeader anchorId="appearance-background" title={t('settings.appearance.background.title')} />
    <SettingCard padded>
      <p className="text-xs text-muted-foreground mb-3">{t('settings.appearance.background.description')}</p>
      {imageUrl && <img src={imageUrl} alt={t('settings.appearance.background.preview')}
        className="mb-3 h-32 w-full rounded-md object-cover" />}
      <div className="flex gap-2 mb-3">
        <Button size="sm" disabled={busy || !actions} onClick={() => void actions?.importImage()}>
          {t('settings.appearance.background.choose')}
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !settings.imageId || !actions}
          onClick={() => void actions?.removeImage()}>{t('settings.appearance.background.remove')}</Button>
      </div>
      <SettingRow label={t('settings.appearance.background.enabled')}>
        <Toggle checked={settings.enabled} disabled={busy || !settings.imageId}
          ariaLabel={t('settings.appearance.background.enabled')}
          onChange={(enabled) => actions?.update({ enabled })} />
      </SettingRow>
      <SettingRow label={t('settings.appearance.background.opacity')}>
        <div className="flex items-center gap-2">
          <input type="range" min={0} max={100} step={1} value={Math.round(settings.surfaceOpacity * 100)}
            aria-label={t('settings.appearance.background.opacity')} disabled={busy || !settings.imageId}
            onChange={(event) => actions?.update({ surfaceOpacity: Number(event.target.value) / 100 })} />
          <span className="w-10 text-right text-xs tabular-nums">{Math.round(settings.surfaceOpacity * 100)}%</span>
        </div>
      </SettingRow>
      {error && <p role="alert" className="mt-2 text-xs text-destructive">{t('settings.appearance.background.error')}</p>}
    </SettingCard>
  </section>;
}
