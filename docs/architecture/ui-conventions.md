# UI conventions

*Read before adding buttons or other shared UI affordances. Update in the same
PR that changes this behaviour.*

## Icon-only buttons need a tooltip

Any button whose only content is a lucide icon (no visible text label) should be
wrapped in `Tooltip`/`TooltipTrigger`/`TooltipContent` (`@/components/ui/tooltip`;
`TooltipProvider` is mounted once in the root layout, so any component can use
it) naming the action, since the icon alone isn't self-explanatory and the
`aria-label` most of these already carry for a11y isn't visible to a sighted
mouse user. Wrap the trigger even when it's already `asChild`'d into something
else — `TooltipTrigger asChild` composes fine stacked on top of
`DropdownMenuTrigger asChild` or `AlertDialogTrigger asChild` (Radix `Slot`
merges through arbitrary depth); skip only elements that are always `disabled`
(disabled buttons get `pointer-events-none`, so a tooltip on one can never show)
and the ubiquitous shadcn dialog/sheet "X" close button (self-evident, has
`sr-only` text already, and a tooltip on every modal close button is more noise
than help).

**Media-player exception**: the gallery video player's transport buttons
(play/pause, mute, full screen in `image-gallery.tsx`) carry `aria-label`s but
no tooltip. They are the same universally-understood glyphs as the dialog "X",
they sit in a bar that already overlays the video, and a tooltip firing as the
pointer crosses them on the way to the scrubber covers the thing being watched.

**Sidebar exception**: don't add a tooltip when the sidebar is expanded and the
button already shows a text label next to the icon — `SidebarMenuButton`'s own
`tooltip` prop already handles this correctly (`src/components/ui/sidebar.tsx`:
it wraps every button in a `Tooltip` but sets `hidden={state !== "collapsed" ||
isMobile}` on the content, so the tooltip only actually appears once the sidebar
is collapsed to icons); follow that pattern rather than reinventing it for new
sidebar items.
