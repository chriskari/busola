import { useTranslation } from 'react-i18next';
import { parse } from '@datasert/cronjs-parser';
import { toString as cRonstrue } from 'cronstrue/i18n';
import { MessageStrip, Text } from '@ui5/webcomponents-react';

import { ResourceForm } from 'shared/ResourceForm';
import * as Inputs from 'shared/ResourceForm/inputs';

const presets = {
  '@yearly': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@hourly': '0 * * * *',
};

function readableSchedule(schedule, i18n) {
  try {
    return cRonstrue(schedule, { locale: i18n.language });
  } catch (_) {
    // handle custom values like '@hourly'
    return schedule;
  }
}

export function isCronExpressionValid(schedule) {
  try {
    parse(schedule);
    return (
      Object.keys(presets).includes(schedule) ||
      schedule.split(' ').filter(e => e).length === 5
    );
  } catch (_) {
    return false;
  }
}

function TimeInput({ entries, index, name, setSchedule }) {
  const { t } = useTranslation();

  const setValue = v => {
    entries[index] = v;
    setSchedule(entries.join(' '));
  };

  return (
    <ResourceForm.FormField
      required
      label={t('cron-jobs.create-modal.' + name)}
      tooltipContent={t('cron-jobs.create-modal.tooltips.' + name)}
      input={() => (
        <Inputs.Text
          value={entries[index] || ''}
          setValue={setValue}
          placeholder={t('cron-jobs.create-modal.' + name)}
          className="full-width"
          required
          accessibleName={t('cron-jobs.create-modal.' + name)}
        />
      )}
    />
  );
}

function ScheduleEditor({ schedule, setSchedule }) {
  const { t } = useTranslation();

  const entries = (presets[schedule] || schedule || '').split(' ');

  const inputNames = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week'];

  return (
    <>
      {inputNames.map((name, i) => (
        <TimeInput
          entries={entries}
          index={i}
          key={i}
          name={name}
          setSchedule={setSchedule}
        />
      ))}
      {!isCronExpressionValid(schedule) && (
        <MessageStrip
          design="Negative"
          hideCloseButton
          className="sap-margin-top-small"
        >
          {t('cron-jobs.create-modal.parse-error')}
        </MessageStrip>
      )}
      <Text className="sap-margin-top-small">
        {t('cron-jobs.create-modal.schedule-description')}
      </Text>
    </>
  );
}

export function ScheduleSection({
  value: schedule,
  setValue: setSchedule,
  tooltipContent,
}) {
  const { t, i18n } = useTranslation();

  const schedulePresets = [
    {
      name: t('cron-jobs.create-modal.presets.yearly'),
      value: '0 0 1 1 *',
    },
    {
      name: t('cron-jobs.create-modal.presets.monthly'),
      value: '0 0 1 * *',
    },
    {
      name: t('cron-jobs.create-modal.presets.weekly'),
      value: '0 0 * * 0',
    },
    {
      name: t('cron-jobs.create-modal.presets.daily'),
      value: '0 0 * * *',
    },
    {
      name: t('cron-jobs.create-modal.presets.hourly'),
      value: '0 * * * *',
    },
  ];

  const presets = (
    <ResourceForm.Presets
      onSelect={({ value }) => setSchedule(value)}
      presets={schedulePresets}
      inlinePresets={true}
    />
  );

  return (
    <ResourceForm.CollapsibleSection
      title={`${t('cron-jobs.schedule')}: ${readableSchedule(schedule, i18n)}`}
      tooltipContent={tooltipContent}
      actions={presets}
      defaultOpen
    >
      <ScheduleEditor schedule={schedule} setSchedule={setSchedule} />
    </ResourceForm.CollapsibleSection>
  );
}
