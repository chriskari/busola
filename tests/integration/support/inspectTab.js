Cypress.Commands.add(
  'inspectTab',
  { prevSubject: ['optional', 'element'] },
  (subject, tabName) => {
    (subject
      ? cy.wrap(subject).find('ui5-tabcontainer')
      : cy.get('ui5-tabcontainer')
    )
      .find('[role="tablist"]')
      .find('[role="tab"]')
      .contains(tabName)
      .should('be.visible')
      .as('tabButton');

    return cy.get('@tabButton').click();
  },
);
