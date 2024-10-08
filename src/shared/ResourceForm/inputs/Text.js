import { useValidation } from 'shared/hooks/useValidation';
import { Input } from '@ui5/webcomponents-react';

export function Text(props) {
  return <WrappedText {...props} />;
}

export function WrappedText({ value, setValue, onChange, inputRef, ...props }) {
  if (!props.readOnly) delete props.readOnly;

  const {
    validationRef,
    internalValue,
    setMultiValue,
    setResource,
    validateMessage,
    ...inputProps
  } = props;

  const validationProps = useValidation({
    inputRef,
    onChange: [onChange, e => setValue && setValue(e.target.value)],
  });

  return (
    <Input
      value={value || ''}
      onInput={onChange ?? (e => setValue && setValue(e.target.value))}
      {...inputProps}
      {...validationProps}
    />
  );
}
