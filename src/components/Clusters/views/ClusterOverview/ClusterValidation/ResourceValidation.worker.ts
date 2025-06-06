/* eslint-disable no-restricted-globals */

import { validateResourceBySchema } from 'shared/hooks/useValidateResourceBySchema/useValidateResourceBySchema';
import { ValidationSchema } from 'state/validationSchemasAtom';
import { K8sResource } from 'types';

let validationRuleset: ValidationSchema;

const ResourceValidation = {
  validate(resources: K8sResource[]) {
    return resources.map(resource =>
      validateResourceBySchema(resource, validationRuleset, {
        base: 'https://dashboard.kyma.cloud.sap', // Workaround for jsonschema 1.5.0 - https://github.com/tdegrunt/jsonschema/issues/407
      }),
    );
  },
  setRuleset(ruleset: ValidationSchema) {
    validationRuleset = ruleset;
  },
};

self.onmessage = event => {
  const [method, ...parameters] = event.data;

  if (method === 'validate') {
    const [resources] = parameters;
    const result = ResourceValidation.validate(resources);
    self.postMessage(result);
  } else if (method === 'setRuleset') {
    const [ruleset] = parameters;
    const result = ResourceValidation.setRuleset(ruleset);
    self.postMessage(result);
  }
};
