Cypress.Commands.add('navigateTo', (leftNav, resource) => {
  const categorySelector = `ui5-side-navigation-item[text="${leftNav}"]`;

  if (!resource) {
    // wait for route commit so a following typeInSearch doesn't race the list mounting
    cy.getLeftNav().get(categorySelector).should('be.visible').click();
    cy.getLeftNav().get(categorySelector).should('have.prop', 'selected', true);
    return;
  }

  const subItemSelector = `ui5-side-navigation-sub-item[text="${resource}"]`;

  // skip if already expanded — a redundant click drops the key from expandedCategories,
  // re-rendering the sidebar and moving the sub-item node mid-click onto the wrong neighbour
  cy.getLeftNav().then(($nav) => {
    if ($nav.find(`${subItemSelector}:visible`).length === 0) {
      cy.getLeftNav().get(categorySelector).should('be.visible').click();
    }
  });

  cy.getLeftNav().get(subItemSelector).should('be.visible').click();

  // selected flips on route commit; stops a following openCreate from grabbing the previous view's button
  cy.getLeftNav().get(subItemSelector).should('have.prop', 'selected', true);
});
