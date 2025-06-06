import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import jp from 'jsonpath';
import * as _ from 'lodash';
import * as Inputs from 'shared/ResourceForm/inputs';
import { ResourceForm } from 'shared/ResourceForm';
import { AdvancedContainersView } from 'shared/components/Deployment/ContainersViews';
import { useSidecar } from 'shared/hooks/useSidecarInjection';

import {
  createContainerTemplate,
  createDeploymentTemplate,
  createPresets,
} from './templates';
import { useRecoilValue } from 'recoil';
import { columnLayoutState } from 'state/columnLayoutAtom';

const ISTIO_INJECTION_LABEL = 'sidecar.istio.io/inject';
const ISTIO_INJECTION_ENABLED = 'true';
const ISTIO_INJECTION_DISABLED = 'false';

export default function DeploymentCreate({
  formElementRef,
  namespace,
  onChange,
  setCustomValid,
  resource: initialDeployment,
  resourceUrl,
  ...props
}) {
  const { t } = useTranslation();

  const [deployment, setDeployment] = useState(
    initialDeployment
      ? _.cloneDeep(initialDeployment)
      : createDeploymentTemplate(namespace),
  );
  const [initialResource, setInitialResource] = useState(
    initialDeployment || createDeploymentTemplate(namespace),
  );
  const layoutState = useRecoilValue(columnLayoutState);

  useEffect(() => {
    if (layoutState?.showEdit?.resource) return;

    setDeployment(
      initialDeployment
        ? _.cloneDeep(initialDeployment)
        : createDeploymentTemplate(namespace),
    );
    setInitialResource(
      initialDeployment || createDeploymentTemplate(namespace),
    );
  }, [initialDeployment, namespace, layoutState?.showEdit?.resource]);

  const isEdit = useMemo(
    () =>
      !!initialResource?.metadata?.name && !!!layoutState?.showCreate?.resource,
    [initialResource, layoutState?.showCreate?.resource],
  );

  const {
    isIstioFeatureOn,
    isSidecarEnabled,
    setSidecarEnabled,
    setIsChanged,
  } = useSidecar({
    initialRes: initialResource,
    res: deployment,
    setRes: setDeployment,
    path: '$.spec.template.metadata.labels',
    label: ISTIO_INJECTION_LABEL,
    enabled: ISTIO_INJECTION_ENABLED,
    disabled: ISTIO_INJECTION_DISABLED,
  });

  useEffect(() => {
    const hasAnyContainers = !!(
      jp.value(deployment, '$.spec.template.spec.containers') || []
    ).length;

    setCustomValid(hasAnyContainers);
  }, [deployment, setCustomValid]);

  const handleNameChange = name => {
    jp.value(deployment, '$.metadata.name', name);
    jp.value(deployment, "$.metadata.labels['app.kubernetes.io/name']", name);
    jp.value(deployment, '$.spec.template.spec.containers[0].name', name);
    jp.value(deployment, '$.spec.selector.matchLabels.app', name); // match labels
    jp.value(deployment, '$.spec.template.metadata.labels.app', name); // pod labels
    setDeployment({ ...deployment });
  };

  return (
    <ResourceForm
      {...props}
      pluralKind="deployments"
      singularName={t(`deployments.name_singular`)}
      resource={deployment}
      setResource={setDeployment}
      onChange={onChange}
      formElementRef={formElementRef}
      presets={!isEdit && createPresets(namespace, t)}
      onPresetSelected={value => {
        setDeployment(value.deployment);
      }}
      // create modal on a namespace details doesn't have the resourceUrl
      createUrl={resourceUrl}
      initialResource={initialResource}
      updateInitialResource={setInitialResource}
      handleNameChange={handleNameChange}
    >
      <ResourceForm.FormField
        required
        propertyPath="$.spec.replicas"
        label={t('replica-sets.create-modal.labels.replicas')}
        input={Inputs.Number}
        placeholder={t('replica-sets.create-modal.placeholders.replicas')}
        tooltipContent={t('replica-sets.create-modal.tooltips.replicas')}
        min={0}
      />

      {isIstioFeatureOn ? (
        <ResourceForm.FormField
          label={t('namespaces.create-modal.enable-sidecar')}
          input={Inputs.Switch}
          checked={isSidecarEnabled}
          onChange={() => {
            setSidecarEnabled(value => !value);
            setIsChanged(true);
          }}
        />
      ) : null}

      <AdvancedContainersView
        resource={deployment}
        setResource={setDeployment}
        onChange={onChange}
        namespace={namespace}
        createContainerTemplate={createContainerTemplate}
      />
    </ResourceForm>
  );
}
