/**
 * Dropdown menu (shadcn/ui, Radix-backed).
 *
 * Styled with utilities against the token bridge in `styles.css`, so it inherits the
 * chart's palette and flips with `data-gantt-theme` like everything else. This is new
 * markup and therefore carries no `.ganttor-*` class — see the cascade-layer note in
 * `styles.css` for why mixing the two would leave the utilities inert.
 *
 * The portal is pointed at the in-scope overlay host rather than `document.body`, which
 * is what keeps `var(--gantt-*)` resolvable inside the menu.
 */

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import type * as React from 'react';

import { cn } from '@/lib/utils.js';
import { overlayContainer } from '@/lib/portal.js';

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;

function DropdownMenuContent({
  className,
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal container={overlayContainer()}>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[11rem] overflow-hidden rounded-md border border-border',
          'bg-popover p-1 text-popover-foreground shadow-lg',
          'data-[state=closed]:opacity-0',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean;
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-variant={variant}
      className={cn(
        'relative flex cursor-pointer select-none items-center gap-2 rounded-sm',
        'px-2 py-1.5 text-[13px] font-medium outline-none',
        'focus:bg-accent focus:text-accent-foreground',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        'data-[variant=destructive]:text-destructive',
        inset && 'pl-8',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      className={cn(
        'px-2 py-1.5 text-[11px] font-bold uppercase tracking-[0.07em] text-muted-foreground',
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('ml-auto pl-4 text-[11px] tracking-widest text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
};
