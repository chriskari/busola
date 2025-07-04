import { useState, useRef, useEffect } from 'react';
import jp from 'jsonpath';
import { cloneDeep } from 'lodash';
import { useTranslation } from 'react-i18next';
import { useSetRecoilState } from 'recoil';

import { ResourceForm } from 'shared/ResourceForm';
import { K8sNameField, TextArrayInput } from 'shared/ResourceForm/fields';
import { ChooseStorage } from 'components/Clusters/components/ChooseStorage';
import { ErrorBoundary } from 'shared/components/ErrorBoundary/ErrorBoundary';
import { useNotification } from 'shared/contexts/NotificationContext';
import * as Inputs from 'shared/ResourceForm/inputs';
import { AuthenticationTypeDropdown } from 'components/Clusters/views/EditCluster/AuthenticationDropdown';
import { useClustersInfo } from 'state/utils/getClustersInfo';
import { authDataState } from 'state/authDataAtom';
import { Title } from '@ui5/webcomponents-react';

import { addCluster, getContext, deleteCluster } from '../../shared';
import { getUserIndex } from '../../shared';
import { ContextButtons } from 'components/Clusters/components/ContextChooser/ContextChooser';

export const findInitialValues = (kubeconfig, id, userIndex = 0) => {
  const elementsWithId =
    kubeconfig?.users?.[userIndex]?.user?.exec?.args.filter(el =>
      el?.includes(id),
    ) || [];
  const regex = new RegExp(`${id}=(?<value>.*)`);
  const values = [];

  for (const element of elementsWithId) {
    const match = regex.exec(element);
    if (match?.groups?.value) {
      values.push(match.groups.value);
    }
  }

  return values;
};

export const findInitialValue = (kubeconfig, id, userIndex = 0) => {
  if (kubeconfig?.users?.[userIndex]?.user?.exec?.args) {
    const elementWithId = kubeconfig?.users?.[
      userIndex
    ]?.user?.exec?.args.find(el => el?.includes(id));
    const regex = new RegExp(`${id}=(?<value>.*)`);
    return regex.exec(elementWithId)?.groups?.value || '';
  }
  return '';
};

export const ClusterDataForm = ({
  kubeconfig,
  setResource,
  onChange,
  onSubmit,
  resourceUrl,
  formElementRef,
  className = '',
  modeSelectorDisabled = false,
  initialMode,
  yamlSearchDisabled,
  yamlHideDisabled,
}) => {
  const { t } = useTranslation();
  const userIndex = getUserIndex(kubeconfig);
  const [authenticationType, setAuthenticationType] = useState(
    kubeconfig?.users?.[userIndex]?.user?.exec ? 'oidc' : 'token',
  );
  const hasOneContext = kubeconfig?.contexts?.length === 1;
  const [chosenContext, setChosenContext] = useState(
    kubeconfig?.['current-context'],
  );
  const issuerUrl = findInitialValue(kubeconfig, 'oidc-issuer-url', userIndex);
  const clientId = findInitialValue(kubeconfig, 'oidc-client-id', userIndex);
  const clientSecret = findInitialValue(
    kubeconfig,
    'oidc-client-secret',
    userIndex,
  );
  const scopes = findInitialValues(kubeconfig, 'oidc-extra-scope', userIndex);

  useEffect(() => {
    setAuthenticationType(
      kubeconfig?.users?.[userIndex]?.user?.exec ? 'oidc' : 'token',
    );
  }, [kubeconfig, userIndex]);

  const tokenFields = (
    <ResourceForm.FormField
      label={t('clusters.token')}
      input={Inputs.Text}
      required
      value={kubeconfig?.users?.[userIndex]?.user?.token}
      setValue={val => {
        jp.value(kubeconfig, `$.users[${userIndex}].user.token`, val);
        setResource({ ...kubeconfig });
      }}
    />
  );

  const createOIDC = (type = '', val = '') => {
    const config = { issuerUrl, clientId, clientSecret, scopes, [type]: val };
    const exec = {
      ...kubeconfig?.users?.[userIndex]?.user?.exec,
      apiVersion: 'client.authentication.k8s.io/v1beta1',
      command: 'kubectl',
      args: [
        'oidc-login',
        'get-token',
        `--oidc-issuer-url=${config.issuerUrl}`,
        `--oidc-client-id=${config.clientId}`,
        `--oidc-client-secret=${config.clientSecret}`,
        ...(config.scopes?.length
          ? config.scopes.map(scope => `--oidc-extra-scope=${scope || ''}`)
          : [`--oidc-extra-scope=openid`]),
        '--grant-type=auto',
      ],
    };
    jp.value(kubeconfig, `$.users[${userIndex}].user.exec`, exec);
    setResource({ ...kubeconfig });
  };

  const OIDCFields = (
    <>
      <ResourceForm.FormField
        label={t('clusters.labels.issuer-url')}
        input={Inputs.Text}
        required
        value={issuerUrl}
        setValue={val => {
          createOIDC('issuerUrl', val);
        }}
      />
      <ResourceForm.FormField
        label={t('clusters.labels.client-id')}
        input={Inputs.Text}
        required
        value={clientId}
        setValue={val => {
          createOIDC('clientId', val);
        }}
      />
      <ResourceForm.FormField
        label={t('clusters.labels.client-secret')}
        input={Inputs.Text}
        value={clientSecret}
        setValue={val => {
          createOIDC('clientSecret', val);
        }}
      />
      <TextArrayInput
        required
        defaultOpen
        title={t('clusters.labels.scopes')}
        value={scopes}
        setValue={val => {
          createOIDC('scopes', val);
        }}
      />
    </>
  );

  return (
    <ResourceForm
      pluralKind="clusters"
      singularName={t(`clusters.name_singular`)}
      resource={kubeconfig}
      setResource={setResource}
      initialResource={kubeconfig}
      onChange={onChange}
      formElementRef={formElementRef}
      createUrl={resourceUrl}
      onSubmit={onSubmit}
      autocompletionDisabled
      disableDefaultFields={true}
      modeSelectorDisabled={modeSelectorDisabled}
      initialMode={initialMode}
      yamlSearchDisabled={yamlSearchDisabled}
      yamlHideDisabled={yamlHideDisabled}
    >
      <div className={className}>
        <K8sNameField
          kind={t('clusters.name_singular')}
          date-testid="cluster-name"
          value={
            kubeconfig ? jp.value(kubeconfig, '$["current-context"]') : null
          }
          setValue={name => {
            if (kubeconfig) {
              jp.value(kubeconfig, '$["current-context"]', name);
              jp.value(kubeconfig, `$.contexts[${userIndex}].name`, name);

              setResource({ ...kubeconfig });
            }
          }}
        />
        {!hasOneContext && (
          <ResourceForm.FormField
            required
            value={chosenContext}
            propertyPath='$["current-context"]'
            label={t('clusters.labels.context')}
            validate={value => !!value}
            setValue={context => {
              jp.value(kubeconfig, '$["current-context"]', context);
              setChosenContext(context);
              setResource({ ...kubeconfig });
            }}
            input={({ setValue }) => (
              <ContextButtons
                contexts={kubeconfig?.contexts || []}
                setValue={setValue}
                chosenContext={chosenContext}
                setChosenContext={setChosenContext}
              />
            )}
          />
        )}
        <ResourceForm.FormField
          label={t('clusters.auth-type')}
          key={t('clusters.auth-type')}
          required
          value={authenticationType}
          setValue={type => {
            if (type === 'token') {
              delete kubeconfig?.users[userIndex]?.user?.exec;
              jp.value(kubeconfig, `$.users[${userIndex}].user.token`, null);
            } else {
              delete kubeconfig.users[userIndex]?.user?.token;
              createOIDC();
            }
            setResource({ ...kubeconfig });
            setAuthenticationType(type);
          }}
          input={({ value, setValue }) => (
            <AuthenticationTypeDropdown type={value} setType={setValue} />
          )}
        />
        {authenticationType === 'token' ? tokenFields : OIDCFields}
      </div>
    </ResourceForm>
  );
};

function EditClusterComponent({
  formElementRef,
  onChange,
  resourceUrl,
  editedCluster,
}) {
  const [resource, setResource] = useState(cloneDeep(editedCluster));
  const { kubeconfig, config } = resource;

  const { t } = useTranslation();
  const notification = useNotification();

  const clustersInfo = useClustersInfo();
  const setAuth = useSetRecoilState(authDataState);
  const originalName = useRef(kubeconfig?.['current-context'] || '');

  const setWholeResource = newKubeconfig => {
    jp.value(resource, '$.kubeconfig', newKubeconfig);
    setResource({ ...resource });
  };

  const onComplete = () => {
    try {
      if (originalName.current !== kubeconfig?.['current-context']) {
        deleteCluster(originalName.current, clustersInfo);
      }
      const contextName = kubeconfig['current-context'];
      setAuth(null);

      addCluster(
        {
          kubeconfig,
          config: { ...(config || {}), config },
          contextName: kubeconfig?.['current-context'],
          currentContext: getContext(kubeconfig, contextName),
          name: kubeconfig?.['current-context'],
        },
        clustersInfo,
      );
    } catch (e) {
      notification.notifyError({
        content: `${t('clusters.messages.wrong-configuration')}. ${
          e instanceof Error && e?.message ? e.message : ''
        }`,
      });
      console.warn(e);
    }
  };

  return (
    <>
      <div className="sap-margin-x-large sap-margin-y-small">
        <Title level="H3" size="H3" className="sap-margin-bottom-small">
          {t('clusters.storage.choose-storage.label')}
        </Title>
        <ChooseStorage
          storage={resource.config?.storage}
          setStorage={type => {
            jp.value(resource, '$.config.storage', type);
            setResource({ ...resource });
          }}
        />
        <ResourceForm.FormField
          className="sap-margin-top-medium"
          label={t('common.headers.description')}
          data-testid="cluster-description"
          input={Inputs.Text}
          placeholder={t('clusters.description-visibility')}
          value={resource.config?.description || ''}
          setValue={value => {
            jp.value(resource, '$.config.description', value);
            setResource({ ...resource });
          }}
        />
      </div>
      <ClusterDataForm
        onChange={onChange}
        kubeconfig={kubeconfig}
        setResource={setWholeResource}
        onSubmit={onComplete}
        formElementRef={formElementRef}
        resourceUrl={resourceUrl}
      />
    </>
  );
}

export function EditCluster(props) {
  return (
    <ErrorBoundary>
      <EditClusterComponent {...props} />
    </ErrorBoundary>
  );
}
