/// <reference types="cypress" />
import 'cypress-file-upload';

const JOB_NAME =
  'test-job-' +
  Math.random()
    .toString()
    .substr(2, 8);

const SECOND_CONTAINER_NAME = JOB_NAME + '-node';

function checkJobLogs({ showLogsSelector, expectedLogs }) {
  cy.wait(10_000);
  cy.get(showLogsSelector).click({ force: true });

  cy.contains(expectedLogs);

  cy.go('back');
}

context('Test Jobs', () => {
  Cypress.skipAfterFail();

  before(() => {
    cy.loginAndSelectCluster();
    cy.goToNamespaceDetails();
  });

  it('Create Job', () => {
    cy.navigateTo('Workloads', 'Jobs');

    cy.openCreate();

    // job name
    cy.get('[accessible-name="Job name"]:visible')
      .find('input')
      .click()
      .clear()
      .type(JOB_NAME, { force: true });

    // job container name
    cy.get('[accessible-name="Container name"]:visible')
      .find('input')
      .type(JOB_NAME, { force: true });

    // job command
    cy.get('[aria-label="Command, collapsed"]').click();
    cy.get('[placeholder^="Command to run"]:visible')
      .find('input')
      .type('/bin/sh', { force: true });

    cy.get('[placeholder^="Command to run"]:visible')
      .parentsUntil('ul')
      .next()
      .find('input')
      .type('-c', { force: true })
      .parentsUntil('ul')
      .next()
      .find('input')
      .type('echo "Busola test"', { force: true });

    // job docker image
    cy.get('[placeholder^="Enter the Docker image tag"]:visible')
      .find('input')
      .type('busybox', { force: true });

    // we can't edit Job's template, so we add 2 containers now
    cy.contains('Add Container').click();
    cy.contains('Container 2').click();

    // job container name
    cy.get('[accessible-name="Container name"]:visible')
      .find('input')
      .type(SECOND_CONTAINER_NAME, { force: true });

    // job args
    cy.get('[aria-label="Args, collapsed"]:visible').click();

    cy.get('[placeholder^="Arguments to the"]:visible')
      .find('input')
      .type('-e', { force: true })
      .parentsUntil('ul')
      .next()
      .find('input')
      .type('console.log("Node image test"); ', { force: true });

    // job docker image
    cy.get('[placeholder^="Enter the Docker image tag"]:visible')
      .find('input')
      .type('node:14-alpine', { force: true });

    cy.saveChanges('Create');
  });

  it('Inspect details and created Pods', () => {
    // name
    cy.getMidColumn().contains(JOB_NAME);

    // created pod
    cy.getMidColumn()
      .find('ui5-panel')
      .find('ui5-table-row')
      .find('ui5-table-cell')
      .contains('ui5-link', JOB_NAME)
      .click();

    cy.wait(1000);

    // images for both containers
    cy.contains(/Imagebusybox/);
    cy.contains(/Imagenode:14-alpine/);

    // controlled-by
    cy.contains('div', 'Controlled By')
      .next()
      .find(`div:contains("Job") ui5-link:contains("${JOB_NAME}")`)
      .should('exist');

    // status
    cy.get('[aria-label="Status"]', { timeout: 75 * 1000 })
      .first()
      .contains('Completed');

    // check logs
    checkJobLogs({
      showLogsSelector: `[accessible-name="view-logs-for-${JOB_NAME}"]`,
      expectedLogs: 'Busola test',
    });
    checkJobLogs({
      showLogsSelector: `[accessible-name="view-logs-for-${SECOND_CONTAINER_NAME}"]`,
      expectedLogs: 'Node image test',
    });

    // back to job
    cy.get('.page-header__column')
      .contains(`Job (${JOB_NAME})`)
      .contains('ui5-link', JOB_NAME)
      .click();

    // pod status
    cy.contains('Completed');
  });

  it('Edit Job', () => {
    cy.wait(1000);

    cy.inspectTab('Edit');

    // containers section should be readonly
    cy.contains('After a Job is created, the containers are read-only.');

    cy.get('.edit-form')
      .get('ui5-button[icon="add"][disabled]')
      .contains('Add Container')
      .should('be.visible');

    // edit labels
    cy.get('.edit-form')
      .contains('Labels')
      .click();

    cy.get('[placeholder="Enter key"]:visible')
      .find('input')
      .filterWithNoValue()
      .type('a', { force: true });

    cy.get('[placeholder="Enter value"]:visible')
      .find('input')
      .filterWithNoValue()
      .first()
      .click()
      .type('b', { force: true });

    cy.saveChanges('Edit');

    cy.inspectTab('View');

    cy.contains('a=b');
  });

  it('Inspect list', () => {
    cy.getLeftNav()
      .contains(/^Jobs/)
      .click();

    cy.contains('ui5-text', JOB_NAME).should('be.visible');
  });
});
