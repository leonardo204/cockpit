import type { Preview } from '@storybook/nextjs-vite'
import React from 'react'
import '../src/app/globals.css'
import { TooltipProvider } from '../src/components/shared/TooltipProvider'

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
       color: /(background|color)$/i,
       date: /Date$/i,
      },
    },
  },
  decorators: [
    // Mount the single global tooltip popover so every <Tooltip> /
    // `data-tooltip` in a story renders correctly without each story
    // having to provide its own.
    (Story) =>
      React.createElement(
        React.Fragment,
        null,
        React.createElement(Story),
        React.createElement(TooltipProvider),
      ),
  ],
};

export default preview;