# UI component attribution

The offline compiler preparation control uses an adaptation of **DynamicButton**, reviewed through the Kitchen component catalog and its linked [public demo](https://www.dqnamo.com/experiments/dynamic-button).

- [Pinned upstream source](https://github.com/dqnamo/website/blob/b6b55a1b8527c0046d4d21ec48df02da8a747653/components/DynamicButton.tsx), dqnamo/website contributors.
- [ISC declaration in the same commit](https://github.com/dqnamo/website/blob/b6b55a1b8527c0046d4d21ec48df02da8a747653/package.json).
- [Local adaptation](../apps/web/src/components/ui/dynamic-button.tsx) and [ISC notice](../apps/web/src/components/ui/DYNAMIC-BUTTON-LICENSE.txt).

The adaptation retains measured content width, keyed label/icon transitions, native button behavior and forwarded ref. It uses existing project button variants and sizes, exposes only the current accessible label, hides measurement/animation copies from accessibility APIs, and removes width/translation/spinner animation under reduced-motion preferences. It shows preparation, download progress, ready and retry states; existing cancellation, cache verification and readiness logic remain in the compiler panel.

Other catalog candidates were not integrated. No Kitchen plugin/tool was installed or invoked; the review used public source and license metadata. Existing shadcn/ui components retain their separate MIT notice. Motion retains its upstream license. This attribution does not change the project's license.
