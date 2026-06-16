/**
 * App-native Select component.
 *
 * Accepts the project's legacy `<Select><option /></Select>` call sites while
 * rendering a Radix-powered menu instead of the browser/system dropdown.
 */
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';

type NativeSelectProps = React.SelectHTMLAttributes<HTMLSelectElement>;

export type SelectProps = Omit<NativeSelectProps, 'children' | 'size'> & {
  children: React.ReactNode;
  placeholder?: string;
  contentClassName?: string;
};

type OptionData = {
  itemValue: string;
  value: string;
  label: React.ReactNode;
  textValue: string;
  disabled: boolean;
};

type OptionElementProps = React.OptionHTMLAttributes<HTMLOptionElement>;

function nodeToText(node: React.ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }

  if (Array.isArray(node)) {
    return node.map(nodeToText).join('');
  }

  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return nodeToText(node.props.children);
  }

  return '';
}

function collectOptions(children: React.ReactNode): OptionData[] {
  const options: OptionData[] = [];

  function visit(nodes: React.ReactNode) {
    React.Children.forEach(nodes, (child) => {
      if (!React.isValidElement<OptionElementProps>(child)) {
        return;
      }

      if (child.type === React.Fragment) {
        visit(child.props.children);
        return;
      }

      if (child.type !== 'option') {
        return;
      }

      const label = child.props.children ?? child.props.label ?? '';
      const textValue = child.props.label ? String(child.props.label) : nodeToText(label);
      const value = child.props.value == null ? textValue : String(child.props.value);
      const index = options.length;

      options.push({
        itemValue: `clawx-select-option-${index}`,
        value,
        label,
        textValue,
        disabled: Boolean(child.props.disabled),
      });
    });
  }

  visit(children);
  return options;
}

const Select = React.forwardRef<HTMLButtonElement, SelectProps>(
  (
    {
      className,
      children,
      value: valueProp,
      defaultValue,
      onChange,
      disabled,
      id,
      name,
      placeholder,
      contentClassName,
      required,
      ...props
    },
    ref,
  ) => {
    const dataTestId = (props as { 'data-testid'?: string })['data-testid'];
    const triggerProps = { ...props } as React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>;
    delete (triggerProps as { 'data-testid'?: string })['data-testid'];

    const options = React.useMemo(() => collectOptions(children), [children]);
    const controlledValue = valueProp == null ? undefined : String(valueProp);
    const initialValue = React.useMemo(() => {
      if (defaultValue != null) {
        return String(defaultValue);
      }

      return options.find((option) => !option.disabled)?.value ?? '';
    }, [defaultValue, options]);
    const [uncontrolledValue, setUncontrolledValue] = React.useState(initialValue);
    const actualValue = controlledValue ?? uncontrolledValue;
    const selectedOption = options.find((option) => option.value === actualValue);
    const selectedItemValue = selectedOption?.itemValue;

    const handleValueChange = React.useCallback((nextItemValue: string) => {
      const nextOption = options.find((option) => option.itemValue === nextItemValue);

      if (!nextOption) {
        return;
      }

      if (controlledValue == null) {
        setUncontrolledValue(nextOption.value);
      }

      onChange?.({
        target: { value: nextOption.value, name, id },
        currentTarget: { value: nextOption.value, name, id },
      } as unknown as React.ChangeEvent<HTMLSelectElement>);
    }, [controlledValue, id, name, onChange, options]);

    return (
      <>
        <SelectPrimitive.Root
          value={selectedItemValue}
          onValueChange={handleValueChange}
          disabled={disabled}
          required={required}
        >
          <SelectPrimitive.Trigger
            ref={ref}
            id={id}
            data-testid={dataTestId}
            data-value={actualValue}
            className={cn(
              'group flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border/70 bg-surface-modal/75 px-3 py-2 text-sm text-foreground shadow-sm shadow-black/5 outline-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 hover:border-ring/35 hover:bg-surface-modal focus-visible:border-ring/60 focus-visible:bg-surface-modal focus-visible:ring-0 data-[state=open]:border-ring/60 data-[state=open]:bg-surface-modal data-[state=open]:shadow-md data-[state=open]:shadow-black/10 disabled:cursor-not-allowed disabled:opacity-50 active:scale-[0.995] dark:shadow-black/20 dark:data-[state=open]:shadow-black/30',
              className,
            )}
            {...triggerProps}
          >
            <SelectPrimitive.Value placeholder={placeholder} />
            <SelectPrimitive.Icon asChild>
              <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180" />
            </SelectPrimitive.Icon>
          </SelectPrimitive.Trigger>
          <SelectPrimitive.Portal>
            <SelectPrimitive.Content
              position="popper"
              sideOffset={6}
              className={cn(
                'z-50 max-h-[min(var(--radix-select-content-available-height),18rem)] min-w-[var(--radix-select-trigger-width)] overflow-hidden rounded-lg border border-border/70 bg-popover/95 text-popover-foreground shadow-xl shadow-black/10 backdrop-blur-xl data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-1 data-[side=top]:slide-in-from-bottom-1 dark:shadow-black/35',
                contentClassName,
              )}
            >
              <SelectPrimitive.ScrollUpButton className="flex h-7 cursor-default items-center justify-center text-muted-foreground">
                <ChevronUp className="h-4 w-4" />
              </SelectPrimitive.ScrollUpButton>
              <SelectPrimitive.Viewport className="p-1">
                {options.map((option) => (
                  <SelectPrimitive.Item
                    key={option.itemValue}
                    value={option.itemValue}
                    textValue={option.textValue}
                    disabled={option.disabled}
                    className="relative flex min-h-8 cursor-default select-none items-center rounded-md py-1.5 pl-2.5 pr-8 text-sm outline-none transition-[background-color,color] duration-150 data-[disabled]:pointer-events-none data-[disabled]:opacity-45 data-[highlighted]:bg-primary/10 data-[highlighted]:text-primary data-[state=checked]:text-foreground"
                  >
                    <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                    <SelectPrimitive.ItemIndicator className="absolute right-2 flex h-4 w-4 items-center justify-center text-primary">
                      <Check className="h-4 w-4" />
                    </SelectPrimitive.ItemIndicator>
                  </SelectPrimitive.Item>
                ))}
              </SelectPrimitive.Viewport>
              <SelectPrimitive.ScrollDownButton className="flex h-7 cursor-default items-center justify-center text-muted-foreground">
                <ChevronDown className="h-4 w-4" />
              </SelectPrimitive.ScrollDownButton>
            </SelectPrimitive.Content>
          </SelectPrimitive.Portal>
        </SelectPrimitive.Root>
        {name && (
          <input
            type="hidden"
            name={name}
            value={actualValue}
            required={required}
            data-testid={dataTestId ? `${dataTestId}-value` : undefined}
            readOnly
          />
        )}
        {!name && dataTestId && (
          <input
            type="hidden"
            value={actualValue}
            data-testid={`${dataTestId}-value`}
            readOnly
          />
        )}
      </>
    );
  },
);
Select.displayName = 'Select';

export { Select };
