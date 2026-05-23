function createServicesTool(name, description) {
  return {
    type: 'function',
    name,
    description,
    strict: true,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        brief: {
          anyOf: [
            { type: 'string' },
            { type: 'null' },
          ],
        },
      },
      required: ['brief'],
    },
  };
}

export const SERVICES_TOOLS = [
  createServicesTool('renderServicesBlock', 'Render a services overview block.'),
  createServicesTool('renderPricesBlock', 'Render a pricing or engagement-model block.'),
  createServicesTool('renderProjectsBlock', 'Render a projects or case-studies block.'),
  createServicesTool('renderAboutBlock', 'Render an about-us block.'),
  createServicesTool('renderContactsBlock', 'Render a contacts or next-step block.'),
];
