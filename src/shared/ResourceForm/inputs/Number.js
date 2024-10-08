import { Input } from '@ui5/webcomponents-react';

export function Number({ value = '', setValue, ...props }) {
  if (!props.readOnly) delete props.readOnly;
  return (
    <Input
      type="Number"
      value={value}
      onInput={e => setValue(parseInt(e.target.value) ?? null)}
      {...props}
    />
  );
}

export function Port({ ...props }) {
  return <Number min={1} max={65535} {...props} />;
}
